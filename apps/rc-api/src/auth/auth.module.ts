import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController, MeController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';
import { HmdmModule } from '../hmdm/hmdm.module';
import { config } from '../config';

@Module({
  imports: [
    HmdmModule,
    JwtModule.register({
      secret: config.jwtSecret(),
      signOptions: { expiresIn: config.jwtExpiresIn() },
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtModule, JwtAuthGuard],
})
export class AuthModule {}
