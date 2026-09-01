import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // 开发期允许 h5（5173）与 admin（5174）跨域；生产由 Nginx 同源反代
  app.enableCors();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`[handover-api] listening on http://localhost:${port}`);
}

void bootstrap();
