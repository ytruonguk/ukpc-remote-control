import './env';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { DevicesModule } from './devices/devices.module';
import { FleetModule } from './fleet/fleet.module';
import { HealthController } from './health.controller';
import { HmdmModule } from './hmdm/hmdm.module';
import { InfraModule } from './infra/infra.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: Number(process.env.API_RATE_LIMIT ?? 100) }] }),
    InfraModule,
    AuthModule,
    DevicesModule,
    SessionsModule,
    FleetModule,
    HmdmModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
