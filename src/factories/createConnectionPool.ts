import { type TypedReadable } from '../types';
import { createUid } from '../utilities/createUid';
import { defer, type DeferredPromise } from '../utilities/defer';
import {
  type Driver,
  type DriverClientEventEmitter,
  type DriverQueryResult,
  type DriverStreamResult,
} from './createDriverFactory';

export type ConnectionPoolClient = {
  acquire: () => void;
  destroy: () => Promise<void>;
  id: () => string;
  isActive: () => boolean;
  isIdle: () => boolean;
  off: DriverClientEventEmitter['off'];
  on: DriverClientEventEmitter['on'];
  query: (query: string, values?: unknown[]) => Promise<DriverQueryResult>;
  release: () => Promise<void>;
  removeListener: DriverClientEventEmitter['removeListener'];
  stream: (
    query: string,
    values?: unknown[],
  ) => TypedReadable<DriverStreamResult>;
};

export type ConnectionPool = {
  acquire: () => Promise<ConnectionPoolClient>;
  end: () => Promise<void>;
  id: () => string;
  state: () => {
    activeConnections: number;
    ended: boolean;
    idleConnections: number;
    waitingClients: number;
  };
};

export const createConnectionPool = ({
  driver,
  poolSize = 1,
}: {
  driver: Driver;
  idleTimeout?: number;
  poolSize?: number;
}): ConnectionPool => {
  // See test "waits for all connections to be established before attempting to terminate the pool"
  // for explanation of why `pendingConnections` is needed.
  const pendingConnections: Array<Promise<ConnectionPoolClient>> = [];

  const connections: ConnectionPoolClient[] = [];

  const waitingClients: Array<DeferredPromise<ConnectionPoolClient>> = [];

  const id = createUid();

  let isEnded = false;

  return {
    acquire: async () => {
      if (isEnded) {
        throw new Error('Connection pool has ended.');
      }

      const idleConnection = connections.find((connection) =>
        connection.isIdle(),
      );

      if (idleConnection) {
        idleConnection.acquire();

        return idleConnection;
      }

      if (connections.length < poolSize) {
        const pendingConnection = driver.createClient();

        pendingConnections.push(pendingConnection);

        const connection = await pendingConnection;

        pendingConnections.splice(
          pendingConnections.indexOf(pendingConnection),
          1,
        );

        const onRelease = () => {
          if (!waitingClients.length) {
            return;
          }

          if (connection.isActive()) {
            // The connection was used by another client.
            return;
          }

          const waitingClient = waitingClients.shift();

          if (!waitingClient) {
            return;
          }

          connection.acquire();

          waitingClient.resolve(connection);
        };

        connection.on('release', onRelease);

        const onDestroy = () => {
          connection.removeListener('release', onRelease);
          connection.removeListener('destroy', onDestroy);

          connections.splice(connections.indexOf(connection), 1);
        };

        connection.on('destroy', onDestroy);

        connections.push(connection);

        connection.acquire();

        return connection;
      } else {
        const waitingClient = defer<ConnectionPoolClient>();

        waitingClients.push(waitingClient);

        return waitingClient.promise;
      }
    },
    end: async () => {
      if (isEnded) {
        return;
      }

      isEnded = true;

      await Promise.all(pendingConnections);

      await Promise.all(connections.map((connection) => connection.release()));

      await Promise.all(connections.map((connection) => connection.destroy()));
    },
    id: () => {
      return id;
    },
    state: () => {
      const idleConnections = connections.filter((connection) =>
        connection.isIdle(),
      );

      return {
        activeConnections: connections.length - idleConnections.length,
        ended: isEnded,
        idleConnections: idleConnections.length,
        waitingClients: waitingClients.length,
      };
    },
  };
};
