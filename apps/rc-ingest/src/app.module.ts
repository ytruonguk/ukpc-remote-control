import './env';
import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IngestService } from './ingest.service';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { ok: true, service: 'rc-ingest' };
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [HealthController],
  providers: [IngestService],
})
export class AppModule {}
