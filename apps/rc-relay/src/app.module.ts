import './env';
import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RelayServer } from './relay.server';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { ok: true, service: 'rc-relay' };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({ secret: process.env.JWT_SECRET ?? 'change-me-in-production' }),
  ],
  controllers: [HealthController],
  providers: [RelayServer],
})
export class AppModule {}
