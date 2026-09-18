import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevicesModule } from '../devices/devices.module';
import { HmdmModule } from '../hmdm/hmdm.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [AuthModule, DevicesModule, HmdmModule],
  controllers: [SessionsController],
  providers: [SessionsService],
})
export class SessionsModule {}
