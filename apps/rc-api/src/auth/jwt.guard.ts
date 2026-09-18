import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export type OperatorJwt = {
  sub: number;
  username: string;
  role: string;
  aud: 'operator';
};

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): OperatorJwt => {
  return ctx.switchToHttp().getRequest().user as OperatorJwt;
});

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      req.user = this.jwt.verify<OperatorJwt>(header.slice(7), { audience: 'operator' });
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
