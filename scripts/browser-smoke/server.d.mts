import type { Server } from 'node:http'

export function createSmokeServer(opts?: { isolation?: boolean; root?: string }): Server
