import * as express from 'express';
import * as expressLogger from 'morgan';
import * as helmet from 'helmet';
import * as cors from 'cors';
import * as expressWsFactory from 'express-ws';
import * as ProviderEngine from 'web3-provider-engine';
import * as FilterSubprovider from 'web3-provider-engine/subproviders/filters';
import * as RpcSubprovider from 'web3-provider-engine/subproviders/rpc';
import { createClient } from 'redis';
import { Request, Response, NextFunction } from 'express';
import { BigNumber } from 'bignumber.js';
import { Pool } from 'pg';
import { ZeroEx } from '0x.js';
import { ConduitRelay } from './modules/client';
import { PostgresRepository, Repository } from './modules/repository';
import { RedisPublisher } from './modules/publisher';
import { RedisSubscriber } from './modules/subscriber/index';
import v0ApiRouteFactory from './modules/rest-api';
import { WebSocketNode } from './modules/ws-api';
// import { OrderWatcher } from './modules/order-watcher';
import { RoutingError } from './types';
import { ConsoleLoggerFactory, Logger } from './util/logger';
import config from './config';
BigNumber.config({
  EXPONENTIAL_AT: 1000,
});

const createApp = async () => {
  const isProduction = config.NODE_ENV === 'production' ? true : false;
  const logger: Logger = ConsoleLoggerFactory({ level: config.LOG_LEVEL });
  const BLOCKCHAIN_NETWORK_ENDPOINT = config.BLOCKCHAIN_NETWORK_ENDPOINT;
  const BLOCKCHAIN_STARTING_BLOCK = config.BLOCKCHAIN_STARTING_BLOCK;
  const ZEROEX_EXCHANGE_SOL_ADDRESS = config.ZERO_EX_EXCHANGE_SOL_ADDRESS;

  logger.log('info', 'Conduit starting...');
  // Set up Web3
  const providerEngine = new ProviderEngine();
  providerEngine.addProvider(new FilterSubprovider());
  providerEngine.addProvider(new RpcSubprovider({ rpcUrl: BLOCKCHAIN_NETWORK_ENDPOINT }));
  providerEngine.start();
  logger.log('verbose', 'Connected to Web3 Provider Engine');

  // Set up ZeroEx
  const zeroEx = new ZeroEx(providerEngine, {
    // todo: figure out how to get this dynamically...
    networkId: 42,
    orderWatcherConfig: { eventPollingIntervalMs: 1000 },
  });
  logger.log('verbose', 'ZeroEx client set up');

  // Set up Redis
  const redisPublisher = config.REDIS_URL ? createClient(config.REDIS_URL) : createClient();
  const redisSubscriber = config.REDIS_URL ? createClient(config.REDIS_URL) : createClient();

  const publisher = new RedisPublisher({ redisPublisher });
  const subscriber = new RedisSubscriber({ redisSubscriber });
  logger.log('debug', 'Connected to Redis instance');

  // Set up Relay Client (Postgres flavor)
  let repository: Repository;
  try {
    const pool = config.DATABASE_URL
      ? new Pool({ connectionString: config.DATABASE_URL })
      : new Pool({
          host: config.PGHOST,
          port: config.PGPORT,
          user: config.PGUSER,
          password: config.PGPASSWORD,
          database: config.PGDATABASE,
        });
    repository = new PostgresRepository({
      postgresPool: pool,
      orderTableName: config.PG_ORDERS_TABLE_NAME || 'orders',
      tokenTableName: config.PG_TOKENS_TABLE_NAME || 'tokens',
      tokenPairTableName: config.PG_TOKEN_PAIRS_TABLE_NAME || 'token_pairs',
      zeroEx,
      logger,
      redisPublisher,
      redisSubscriber,
    });
    await pool.connect();
    logger.log('debug', `Connected to Postgres database`);
  } catch (e) {
    logger.log('error', 'Error connecting to Postgres', e);
    throw e;
  }
  const conduit = new ConduitRelay({ zeroEx, repository, logger, publisher });
  logger.log('debug', `Connected to Relay client`);

  // OrderWatcher doesn't work right now...
  // Set up order watcher
  // const orderWatcher = new OrderWatcher(zeroEx, relayClient, redisPublisher, redisSubscriber, logger);
  // logger.log('debug', `Connected to OrderWatcher`);
  // const orders = await relayClient.getOrders({ isOpen: true });
  // await orderWatcher.watchOrderBatch(orders);
  // logger.log('debug', `Subscribed to updates for all ${orders.length} open orders`);

  // Set up express application (REST/WS endpoints)
  const app = express();
  const expressWs = expressWsFactory(app);
  app.set('trust proxy', true);
  app.use('/', express.static(__dirname + '/public'));
  app.use(expressLogger('dev'));
  app.use(helmet());
  app.use(cors());

  app.get('/healthcheck', (req, res) => res.sendStatus(200));
  app.get('/', (req, res) => res.send('Welcome to the Conduit Relay API'));
  app.use('/api/v0', v0ApiRouteFactory(conduit, zeroEx, logger));
  logger.log('verbose', 'Configured REST endpoints');

  const wss = expressWs.getWss('/ws');
  const webSocketNode = new WebSocketNode({
    logger,
    wss,
    publisher,
    subscriber,
    relay: conduit,
  });
  (app as any).ws('/ws', (ws, req, next) => webSocketNode.connectionHandler(ws, req, next));
  logger.log('verbose', 'Configured WebSocket endpoints');

  app.use((req: Request, res: Response, next: NextFunction) => {
    const err = new RoutingError('Not Found');
    err.status = 404;
    next(err);
  });

  app.use((error: RoutingError | any, req: Request, res: Response, next: NextFunction) => {
    res.status(error.status || 500);
    res.json({ ...error });
  });

  return app;
};

export default createApp;
