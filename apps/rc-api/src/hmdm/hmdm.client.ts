import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';

export type HmdmProfile = { login: string; userId: number };

@Injectable()
export class HmdmClient {
  private readonly log = new Logger(HmdmClient.name);
  private cachedToken: { value: string; exp: number } | null = null;

  async token(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.exp) return this.cachedToken.value;
    const base = config.hmdmBaseUrl();
    if (!base) throw new Error('HMDM_BASE_URL is not set');
    const res = await fetch(`${base}/rest/public/jwt/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: config.hmdmUsername(), password: config.hmdmPassword() }),
    });
    if (!res.ok) throw new Error(`Headwind login failed: ${res.status}`);
    const body = (await res.json()) as { id_token?: string; token?: string };
    const value = body.id_token ?? body.token;
    if (!value) throw new Error('Headwind login returned no token');
    this.cachedToken = { value, exp: Date.now() + 50 * 60_000 };
    return value;
  }

  async verifyLoginToken(hmdmToken: string): Promise<HmdmProfile> {
    const base = config.hmdmBaseUrl();
    if (!base) throw new Error('HMDM_BASE_URL is not set');
    const res = await fetch(`${base}/rest/private/users/current`, {
      headers: { Authorization: `Bearer ${hmdmToken}` },
    });
    if (!res.ok) throw new Error(`Headwind user lookup failed: ${res.status}`);
    const body = (await res.json()) as { login?: string; name?: string; id?: number };
    return { login: body.login ?? body.name ?? 'unknown', userId: body.id ?? 0 };
  }

  async searchDevices(token: string): Promise<Array<Record<string, unknown>>> {
    const base = config.hmdmBaseUrl();
    const res = await fetch(`${base}/rest/private/devices/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Headwind device search failed: ${res.status}`);
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    return Array.isArray(body) ? body : (body.data ?? []);
  }

  async wake(deviceNumber: string): Promise<boolean> {
    const base = config.hmdmBaseUrl();
    if (!base) {
      this.log.warn('wake skipped: HMDM_BASE_URL empty');
      return false;
    }
    try {
      const token = await this.token();
      const res = await fetch(`${base}/rest/plugins/devicelog/device/push`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceNumber,
          messageType: 'runApp',
          payload: {
            pkg: config.hmdmAgentPackage(),
            action: config.hmdmWakeAction(),
            extra: { reason: 'rc_session' },
          },
        }),
      });
      return res.ok;
    } catch (err) {
      this.log.warn(`wake failed for ${deviceNumber}: ${String(err)}`);
      return false;
    }
  }
}
