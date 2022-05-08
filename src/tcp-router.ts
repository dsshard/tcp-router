import { createServer, Server, Socket } from 'net'
import { Middleware, Pipeline } from './pipeline'
import crypto, { DiffieHellman } from 'crypto'
import { BaseInterface } from './interface'
import { sha256 } from './crypto'

export interface TcpRouterOptions {
  port: number
  host?: string
  prefix?: string
  secret: string
  whitelist?: string[]
}

export interface HandshakeInitialBody {
  [n: number]: string
}

export interface RequestBody {
  uuid: string
  body: any
  rout: string
}

export type ResponseBody = Omit<RequestBody, 'rout'>

declare module 'net' {
  interface Socket {
    secret: string;
  }
}

export class TcpRouter extends BaseInterface {
  private server: Server;
  private options: TcpRouterOptions;
  private routers: Pipeline<any>[] = []
  private dh: DiffieHellman;

  constructor (options: TcpRouterOptions) {
    super()
    this.options = options
    this.server = createServer((socket) => this.handleSocket(socket))
  }

  public listen (callback?) {
    this.server.listen(this.options.port, this.options.host || undefined, callback)
  }

  protected getSecretKey (socket: Socket) {
    return `${this.options.secret}${socket?.secret || ''}`
  }

  private async handleSocket (socket: Socket) {
    const info = <{ address: string }> socket.address()

    if (this.options.whitelist?.length) {
      if (!this.options.whitelist.includes(info.address)) {
        this.emit('whitelist', socket)
        socket.end()
        return
      }
    }
    this.handshake(socket)
  }

  private handshake (socket) {
    socket.once('data', (socketData) => {
      const response = this.decrypt<HandshakeInitialBody>(socketData.toString(), socket)
      const rnd = Math.round(Date.now() / 1000 / 3)
      const key1 = sha256(rnd.toString() + this.getSecretKey(socket))
      const key2 = sha256((rnd + 1).toString() + this.getSecretKey(socket))

      if (!response || !response[key1]) {
        socket.end()
        return
      }

      const prime = Buffer.from(response[key1], 'hex')
      const pub = Buffer.from(response[key2], 'hex')
      this.dh = crypto.createDiffieHellman(prime)
      this.dh.generateKeys()

      const data: HandshakeInitialBody = {
        [key2]: this.dh.getPublicKey().toString('hex')
      }
      socket.write(this.encrypt(JSON.stringify(data)))
      socket.secret = this.dh.computeSecret(pub).toString('hex')

      this.emit('connect', socket)

      socket.on('data', (data) => this.handleSocketData(data, socket))
      socket.on('close', () => {
        socket.secret = ''
        this.emit('close', socket)
      })
    })
  }

  private async handleSocketData (socketData: Buffer, socket: Socket) {
    let response = null
    try {
      const data = socketData.toString()
      response = this.decrypt(data, socket)
      this.emit('data', response?.body)
    } catch (error) {
      console.error('Failed', error.message)
      return
    }

    if (!response) {
      console.error('Failed', 'response is empty')
      return
    }

    const router = this.routers[response.rout]
    let body

    if (router) {
      const result = await router.execute({ body: response.body })
      body = result?.body
    }

    let res = JSON.stringify(<ResponseBody>{ body, uuid: response.uuid })
    res = this.encrypt(res, socket)
    socket.write(res)
  }

  public use (rout: string, ...middlewares: Middleware<any>[]) {
    const pipe = Pipeline()
    pipe.push(...middlewares)
    this.routers[(this.options.prefix || '') + rout] = pipe
  }
}