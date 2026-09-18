import { Injectable, UnauthorizedException } from '@nestjs/common';
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
