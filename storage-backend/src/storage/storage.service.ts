import { Injectable, Logger } from '@nestjs/common';
import * as Keyv from 'keyv';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  storagesMap = new Map<string, Keyv>();

  constructor() {
    const uri = process.env[`STORAGE_URI`];
    if (!uri) {
      this.logger.warn(
        `STORAGE_URI is undefined, will use non persistant in memory storage`,
      );
    }

    // Happy-Hoody patch: default TTL (in ms) applied to every stored entry so
    // shareable links self-expire. Configured via STORAGE_TTL; unset = no expiry.
    const ttlRaw = process.env[`STORAGE_TTL`];
    const ttl = ttlRaw ? parseInt(ttlRaw, 10) : undefined;
    if (ttl) {
      this.logger.log(`STORAGE_TTL set: entries expire after ${ttl}ms`);
    }

    Object.keys(StorageNamespace).forEach((namespace) => {
      const keyv = new Keyv({
        uri,
        namespace,
        ttl,
      });
      keyv.on('error', (err) =>
        this.logger.error(`Connection Error for namespace ${namespace}`, err),
      );
      this.storagesMap.set(namespace, keyv);
    });
  }
  get(key: string, namespace: StorageNamespace): Promise<Buffer> {
    return this.storagesMap.get(namespace).get(key);
  }
  async has(key: string, namespace: StorageNamespace): Promise<boolean> {
    return !!(await this.storagesMap.get(namespace).get(key));
  }
  set(key: string, value: Buffer, namespace: StorageNamespace): Promise<true> {
    return this.storagesMap.get(namespace).set(key, value);
  }
}

export enum StorageNamespace {
  SCENES = 'SCENES',
  ROOMS = 'ROOMS',
  FILES = 'FILES',
}
