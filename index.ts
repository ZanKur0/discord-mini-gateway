import WebSocket from "ws";
import { EventEmitter } from "events";
import { Gateway_url } from "./types";
import Http from "http";

let p = (func: any) => {
  return (data: string) => {
    func(JSON.parse(data));
  };
};

let e = JSON.stringify;
let encoding = "json";

try {
  const erlpack = require("erlpack");
  p = (func) => {
    return (data) => {
      func(erlpack.unpack(data));
    };
  };
  e = erlpack.pack;
  encoding = "etf";
} catch (e) {}

class Connection {
  socket: any;
  hbinterval: any;
  hbfunc: any;
  hbtimer: any;
  s: any;
  session: any;
  shard: any;
  main: any;

  constructor(main: any, shard: number) {
    this.socket = null;
    this.hbinterval = null;
    this.hbfunc = null;
    this.hbtimer = null;
    this.s = -1;
    this.session = -1;
    this.shard = shard;
    this.main = main;
  }

  acknowledge() {
    this.main.emit("DEBUG", this.shard, "hb acknowledged");
    this.hbfunc = this.beat;
  }

  beat() {
    this.main.emit("DEBUG", this.shard, "sending hb");
    this.socket.send(
      JSON.stringify({
        op: 1,
        d: this.s,
      })
    );
    this.hbfunc = this.resume;
  }

  resume() {
    this.main.emit("DEBUG", this.shard, "attempting resume");
    this.close()
      .then(() => this.connect())
      .then(() => {
        this.main.emit("DEBUG", this.shard, "sent resume packet");
        this.socket.send(
          JSON.stringify({
            op: 6,
            d: {
              token: this.main.token,
              session_id: this.session,
              seq: this.s,
            },
          })
        );
      });
  }

  close() {
    this.main.emit(
      "DEBUG",
      this.shard,
      "client attempting to close connection"
    );
    if (this.hbtimer) {
      clearInterval(this.hbtimer);
    }
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== 3) {
        this.socket.close(1001, "cya later alligator");
        this.socket.removeAllListeners("close");
        this.socket.once("close", () => {
          this.main.emit("DEBUG", this.shard, "client closed connection");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  connect(cb?: any) {
    this.main.emit("DEBUG", this.shard, "starting connection packet");
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.main.url + "?encoding=" + encoding);
      this.socket.once("open", () => {
        this.main.emit("DEBUG", this.shard, "opened connection");
        this.socket.once(
          "message",
          p((payload: any) => {
            this.main.emit(
              "DEBUG",
              this.shard,
              "recieved heartbeat info " + JSON.stringify(payload.d)
            );
            this.hbinterval = payload.d.heartbeat_interval;
            this.hbfunc = this.beat;
            if (this.hbtimer) {
              clearInterval(this.hbtimer);
            }
            this.hbtimer = setInterval(() => this.hbfunc(), this.hbinterval);
            if (!cb) {
              setTimeout(
                () => resolve(this.identify()),
                5000 - Date.now() + this.main.lastReady
              );
            } else {
              resolve(cb());
            }
          })
        );
      });
      this.socket.once("close", (code: any, reason: any) => {
        this.main.emit(
          "DEBUG",
          this.shard,
          "server closed connection. code: " +
            code +
            ", reason: " +
            reason +
            " reconnecting in 10"
        );
        setTimeout(() => this.close().then(() => this.connect()), 10000);
      });
      this.socket.once("error", () => {
        this.main.emit(
          "DEBUG",
          this.shard,
          "recieved error " + JSON.stringify(onmessage) + ", reconnecting in 5"
        );
        setTimeout(() => this.close().then(() => this.connect()), 5000);
      });
    });
  }

  send(data: any) {
    this.socket.send(JSON.stringify(data));
  }

  identify() {
    return new Promise((resolve, reject) => {
      this.main.emit("DEBUG", this.shard, "sent identify packet");
      this.socket.send(
        JSON.stringify({
          op: 2,
          d: {
            token: this.main.token,
            properties: {},
            shard: [this.shard, this.main.shards],
            compress: false,
            large_threshold: 250,
            presence: {},
          },
        })
      );
      this.socket.on(
        "message",
        p((payload: any) => {
          this.s = payload.s;
          this.main.emit("PAYLOAD", this.shard, payload);
          if (payload.op === 11) {
            this.acknowledge();
          } else if (payload.t === "RESUMED") {
            this.main.emit("DEBUG", this.shard, "successfully resumed");
          } else if (payload.op === 0) {
            this.main.emit(payload.t, this.shard, payload.d);
          }
        })
      );
      this.socket.once(
        "message",
        p((payload: any) => {
          if (payload.t === "READY") {
            this.session = payload.d.session_id;
            this.main.emit("DEBUG", this.shard, "is ready");
            resolve({ timeReady: Date.now(), socket: this });
          } else if (payload.op === 9) {
            this.main.emit(
              "DEBUG",
              this.shard,
              "invalid session, reconnecting in 5"
            );
            setTimeout(() => this.close().then(() => this.connect()), 5000);
          }
        })
      );
    });
  }
}

class GatewaySocket extends EventEmitter {
  token: string;
  shards: number | string;
  sockets: Map<any, any>;
  lastReady: number;
  url: string;
  constructor(token: string, shards: string | number = "auto") {
    super();
    this.token = token;
    this.shards = shards;
    this.sockets = new Map();
    this.lastReady = 0;
    this.url = "";
  }

  getGatewayInfo() {
    return new Promise<Gateway_url>((resolve, reject) => {
      const http = Http;
      http
        .get(
          {
            hostname: "discordapp.com",
            path: "/api/gateway",
          },
          (res: Http.IncomingMessage) => {
            let data: string = "";
            res.on("data", (data: any) => {
              data += res;
            });
            res.on("end", () => {
              resolve(JSON.parse(data));
            });
          }
        )
        .on("error", reject);
    });
  }

  async connect(start = 0, end: any) {
    const Url: Gateway_url = await this.getGatewayInfo();
    this.url = Url.url;
    for (let i = start; i < end; i++) {
      if (this.sockets.get(i)) {
        await this.sockets.get(i).close();
      }
      this.sockets.set(i, new Connection(this, i));
      this.lastReady = (await this.sockets.get(i).connect()).timeReady;
    }
  }

  send(data: any, shard = 0) {
    this.sockets.get(shard).send(data);
  }
}

function connectToGateway(token: string, shards: number = 0) {
  return new GatewaySocket(token, shards);
}

module.exports = connectToGateway;
