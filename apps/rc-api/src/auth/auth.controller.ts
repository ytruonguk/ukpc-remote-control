import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsString } from 'class-validator';
import { AuthService } from './auth.service';
import { CurrentUser, JwtAuthGuard, type OperatorJwt } from './jwt.guard';

class LoginDto {
  @IsString()
  username!: string;
  @IsString()
  password!: string;
}

class HmdmLoginDto {
  @IsString()
  hmdmToken!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: LoginDto) {
    return this.auth.login(body.username, body.password);
  }

  @Post('hmdm')
  loginHmdm(@Body() body: HmdmLoginDto) {
    return this.auth.loginHmdm(body.hmdmToken);
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: OperatorJwt) {
    return this.auth.me(user.sub);
  }
}
