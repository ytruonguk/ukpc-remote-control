import './env';
import 'reflect-metadata';
import type { Server as HttpServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RelayServer } from './relay.server';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const relay = app.get(RelayServer);
  const port = Number(process.env.RELAY_PORT ?? 3001);
  await app.listen(port, process.env.RELAY_BIND ?? '0.0.0.0');
  relay.attach(app.getHttpServer() as HttpServer);
}

bootstrap();
