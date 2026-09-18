import './env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.INGEST_PORT ?? 3002);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
