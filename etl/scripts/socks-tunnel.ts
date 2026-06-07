/**
 * SOCKS5 → TCP tunnel: forwards local port through SOCKS5 proxy to a remote host.
 *
 * Usage: npx tsx etl/scripts/socks-tunnel.ts
 *
 * Env vars:
 *   TUNNEL_LOCAL_PORT   - local port to listen on (default: 5433)
 *   TUNNEL_REMOTE_HOST  - remote host (default: aws-1-us-east-1.pooler.supabase.com)
 *   TUNNEL_REMOTE_PORT  - remote port (default: 5432)
 *   TUNNEL_PROXY_HOST  - SOCKS5 proxy host (default: 127.0.0.1)
 *   TUNNEL_PROXY_PORT  - SOCKS5 proxy port (default: 10808)
 */
import { SocksClient } from 'socks';
import * as net from 'net';

const LOCAL_PORT = parseInt(process.env.TUNNEL_LOCAL_PORT || '5433', 10);
const REMOTE_HOST = process.env.TUNNEL_REMOTE_HOST || 'aws-1-us-east-1.pooler.supabase.com';
const REMOTE_PORT = parseInt(process.env.TUNNEL_REMOTE_PORT || '5432', 10);
const PROXY_HOST = process.env.TUNNEL_PROXY_HOST || '127.0.0.1';
const PROXY_PORT = parseInt(process.env.TUNNEL_PROXY_PORT || '10808', 10);

const server = net.createServer((localSocket) => {
  SocksClient.createConnection({
    proxy: { host: PROXY_HOST, port: PROXY_PORT, type: 5 },
    command: 'connect',
    destination: { host: REMOTE_HOST, port: REMOTE_PORT },
  }).then(({ socket: remoteSocket }) => {
    localSocket.pipe(remoteSocket);
    remoteSocket.pipe(localSocket);

    localSocket.on('error', (e) => {
      remoteSocket.destroy();
    });
    remoteSocket.on('error', (e) => {
      localSocket.destroy();
    });
    localSocket.on('end', () => remoteSocket.end());
    remoteSocket.on('end', () => localSocket.end());
  }).catch((err) => {
    localSocket.destroy();
  });
});

server.listen(LOCAL_PORT, '127.0.0.1', () => {
  console.log(`SOCKS tunnel: 127.0.0.1:${LOCAL_PORT} → ${REMOTE_HOST}:${REMOTE_PORT} (via socks://${PROXY_HOST}:${PROXY_PORT})`);
});

// Keep running until SIGINT/SIGTERM
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
