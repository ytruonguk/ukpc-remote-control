import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PgService, RedisService } from './infra/infra.module';

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async health() {
    await this.pg.pool.query('SELECT 1');
    await this.redis.ping();
    return { ok: true, service: 'rc-api' };
  }
}
