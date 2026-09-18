import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';

@Module({
  imports: [AuthModule],
  controllers: [FleetController],
  providers: [FleetService],
})
export class FleetModule {}
