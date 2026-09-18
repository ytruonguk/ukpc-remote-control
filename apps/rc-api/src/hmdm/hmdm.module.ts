import { Module } from '@nestjs/common';
import { HmdmClient } from './hmdm.client';
import { HmdmSyncService } from './hmdm.sync';

@Module({
  providers: [HmdmClient, HmdmSyncService],
  exports: [HmdmClient],
})
export class HmdmModule {}
