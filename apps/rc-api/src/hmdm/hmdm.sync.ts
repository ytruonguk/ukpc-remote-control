import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../infra/infra.module';
import { HmdmClient } from './hmdm.client';
import { config } from '../config';

@Injectable()
export class HmdmSyncService {
  private readonly log = new Logger(HmdmSyncService.name);

  constructor(
    private readonly hmdm: HmdmClient,
    private readonly pg: PgService,
  ) {}

  @Cron('*/5 * * * *')
  async syncFromHeadwind() {
    if (!config.hmdmBaseUrl()) return;
    try {
      const token = await this.hmdm.token();
      const devices = await this.hmdm.searchDevices(token);
      const numbers: string[] = [];

      for (const d of devices) {
        const number = String(d.number ?? d.deviceNumber ?? '');
        if (!number) continue;
        numbers.push(number);
        const groupId = await this.mapGroup(d.groupId as number | undefined);
        await this.pg.pool.query(
          `INSERT INTO devices (device_id, hmdm_internal_id, model, os_version, group_id, label, synced_at, stale)
           VALUES ($1, $2, $3, $4, $5, $6, now(), false)
           ON CONFLICT (device_id) DO UPDATE SET
             hmdm_internal_id = EXCLUDED.hmdm_internal_id,
             model = EXCLUDED.model,
             os_version = EXCLUDED.os_version,
             group_id = EXCLUDED.group_id,
             label = COALESCE(EXCLUDED.label, devices.label),
             synced_at = now(),
             stale = false`,
          [
            number,
            d.id ?? null,
            d.model ?? null,
            d.osVersion ?? d.os_version ?? null,
            groupId,
            d.name ?? d.description ?? null,
          ],
        );
      }

      if (numbers.length) {
        await this.pg.pool.query(
          `UPDATE devices SET stale = true WHERE device_id <> ALL($1::text[])`,
          [numbers],
        );
      }
    } catch (err) {
      this.log.warn(`Headwind sync skipped: ${String(err)}`);
    }
  }

  private async mapGroup(hmdmGroupId?: number): Promise<number> {
    if (!hmdmGroupId) {
      const { rows } = await this.pg.pool.query<{ id: number }>(
        `SELECT id FROM device_groups WHERE name = 'default' LIMIT 1`,
      );
      return rows[0].id;
    }
    const { rows } = await this.pg.pool.query<{ id: number }>(
      `INSERT INTO device_groups (name, hmdm_group_id)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET hmdm_group_id = EXCLUDED.hmdm_group_id
       RETURNING id`,
      [`hmdm-${hmdmGroupId}`, hmdmGroupId],
    );
    return rows[0].id;
  }
}
