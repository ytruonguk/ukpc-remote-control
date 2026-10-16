import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PgService } from '../infra/infra.module';
import { HmdmClient } from '../hmdm/hmdm.client';
import { config } from '../config';

type OperatorRow = {
  id: number;
  username: string;
  display_name: string | null;
  password_hash: string | null;
  role: string;
  active: boolean;
};

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly pg: PgService,
    private readonly jwt: JwtService,
    private readonly hmdm: HmdmClient,
  ) {}

  async login(username: string, password: string) {
    const { rows } = await this.pg.pool.query<OperatorRow>(
      `SELECT id, username, display_name, password_hash, role, active
       FROM operators WHERE username = $1`,
      [username],
    );
    const op = rows[0];
    if (!op?.active || !op.password_hash) throw new UnauthorizedException();
    const ok = await bcrypt.compare(password, op.password_hash);
    if (!ok) throw new UnauthorizedException();
    return this.issue(op);
  }

  async loginHmdm(hmdmToken: string) {
    const profile = await this.hmdm.verifyLoginToken(hmdmToken);
    const op = await this.upsertFromHmdm(profile.login, profile.userId);
    return this.issue(op);
  }

  /**
   * Signs in a Headwind user who arrives from the MDM console with a single-use token
   * issued by the RustDesk API. The MDM already decided the user may see the device, so
   * these operators get the 'mdm_user' role: every device, none of the admin rights.
   */
  async loginSso(ssoToken: string, deviceId: string) {
    const base = config.rustdeskApiUrl();
    const apiKey = config.rustdeskApiKey();
    if (!base || !apiKey) {
      this.log.error('SSO is not configured: set RUSTDESK_API_URL and RUSTDESK_API_KEY');
      throw new UnauthorizedException();
    }

    let verified: { valid?: boolean; data?: { user?: string; serial?: string } };
    try {
      const res = await fetch(`${base}/rest/private/remote-token/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ token: ssoToken }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new UnauthorizedException();
      verified = (await res.json()) as typeof verified;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.log.warn(`SSO verification failed: ${String(err)}`);
      throw new UnauthorizedException();
    }

    const user = verified.data?.user;
    if (!verified.valid || !user || verified.data?.serial !== deviceId) {
      throw new UnauthorizedException();
    }

    // The 'mdm:' prefix keeps these operators apart from local ones, so an MDM user who
    // happens to be called 'admin' never lands on the local admin account.
    const { rows } = await this.pg.pool.query<OperatorRow>(
      `INSERT INTO operators (username, display_name, role, active)
       VALUES ($1, $2, 'mdm_user', true)
       ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, username, display_name, password_hash, role, active`,
      [`mdm:${user}`, user],
    );
    const op = rows[0];
    if (!op.active || op.role !== 'mdm_user') throw new UnauthorizedException();
    return this.issue(op);
  }

  async me(id: number) {
    const { rows } = await this.pg.pool.query(
      `SELECT id, username, display_name, role, active FROM operators WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  private issue(op: Pick<OperatorRow, 'id' | 'username' | 'role' | 'display_name'>) {
      const token = this.jwt.sign(
      { sub: op.id, username: op.username, role: op.role },
      { expiresIn: config.jwtExpiresIn(), audience: 'operator' },
    );
    return {
      token,
      user: { id: op.id, username: op.username, displayName: op.display_name, role: op.role },
    };
  }

  private async upsertFromHmdm(login: string, hmdmUserId: number): Promise<OperatorRow> {
    const { rows } = await this.pg.pool.query<OperatorRow>(
      `INSERT INTO operators (username, display_name, hmdm_user_id, role, active)
       VALUES ($1, $1, $2, 'operator', true)
       ON CONFLICT (username) DO UPDATE SET hmdm_user_id = EXCLUDED.hmdm_user_id, active = true
       RETURNING id, username, display_name, password_hash, role, active`,
      [login, hmdmUserId],
    );
    return rows[0];
  }
}
