import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  root(): { app: string; status: string } {
    return { app: 'handover-api', status: 'ok' };
  }

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
