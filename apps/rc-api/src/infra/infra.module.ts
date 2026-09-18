import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config';

@Injectable()
export class PgService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: config.databaseUrl() });
  onModuleDestroy() {
    return this.pool.end();
  }
}

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor() {
    super(config.redisUrl());
  }
  onModuleDestroy() {
    return this.quit();
  }
}

@Injectable()
export class MqttService implements OnModuleDestroy {
  readonly client: MqttClient;

  constructor() {
    this.client = mqtt.connect(config.mqttUrl(), {
      clientId: `rc-api-${process.pid}`,
      clean: true,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
    });
  }

  publish(topic: string, payload: unknown, opts?: { qos?: 0 | 1 | 2 }): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.publish(topic, JSON.stringify(payload), { qos: opts?.qos ?? 1 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  onModuleDestroy() {
    this.client.end(true);
  }
}

@Global()
@Module({
  providers: [PgService, RedisService, MqttService],
  exports: [PgService, RedisService, MqttService],
})
export class InfraModule {}
