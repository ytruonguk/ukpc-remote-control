import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { ConnService } from './conn.service';
import { HwService } from './hw.service';

@Module({
  imports: [AuthModule],
  controllers: [DevicesController],
  providers: [DevicesService, HwService, ConnService],
  exports: [DevicesService],
})
export class DevicesModule {}
