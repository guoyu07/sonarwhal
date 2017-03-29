/**
 * @fileoverview Simple HTTP server used in sonar's tests to mimick certain scenarios.
 *
 */
import * as http from 'http';

import * as express from 'express';
import * as _ from 'lodash';

type ServerConfiguration = string | object; //eslint-disable-line

const startPort = 3000;
const maxPort = 65535;

/** A testing server for Sonar rules */
class Server {
    private _app: express;
    private _server: http.Server;
    private _port: number = startPort;

    constructor() {
        this._app = express();
    }

    /** Because we don't know the port until we start the server, we need to update
     * the references to http://localhost in the HTML to http://localhost:finalport.
    */
    private updateLocalhost(html: string): string {
        return html.replace(/http:\/\/localhost\//g, `http://localhost:${this._port}/`);
    }

    /** Applies the configuration for routes to the server. */
    configure(configuration: ServerConfiguration) {
        if (typeof configuration === 'string') {
            this._app.get('/', (req, res) => {
                res.send(configuration);
            });

            return;
        }

        _.forEach(configuration, (value, key) => {
            let content;

            if (typeof value === 'string') {
                content = this.updateLocalhost(value);
            } else if (typeof value.content === 'string') {
                content = this.updateLocalhost(value.content);
            } else {
                content = '';
            }

            this._app.get(key, (req, res) => {
                if (value.status) {
                    res.status(value.status).send(content);

                    return;
                }
                res.send(content);
            });
        });
    }

    /** Starts listening on the given port. */
    start() {
        return new Promise((resolve, reject) => {
            this._server = http.createServer(this._app);

            // TODO: need to find a way to cast `err` to a [System Error](https://nodejs.org/dist/latest-v7.x/docs/api/errors.html#errors_system_errors)
            this._server.on('error', (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    this._port++;
                    if (this._port > maxPort) {
                        // We start in the initial port again, some must be available
                        this._port = startPort;
                    }
                    this._server.listen(this._port);
                } else {
                    reject(err);
                }
            });

            this._server.once('listening', resolve);

            this._server.listen(this._port);
        });
    }

    /** Stops the server and frees the port. */
    stop() {
        this._server.close();
    }

    get port() {
        return this._port;
    }
}

/** Returns a testing server */
const createServer = () => {
    const server = new Server();

    return server;
};

export { createServer, Server };