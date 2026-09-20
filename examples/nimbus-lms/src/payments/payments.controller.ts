import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Public, Roles, RolesGuard } from '../common/roles.guard';
import { PaymentsService } from './payments.service';

@Controller('payments')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Roles(Role.STUDENT)
  @Post('checkout')
  checkout(@Body() dto: any) { return this.payments.checkout(dto); }

  // Stripe calls this with a signed payload, so it cannot carry a session.
  @Public()
  @Post('webhook')
  webhook(@Body() event: any) { return this.payments.handleWebhook(event); }

  @Roles(Role.ADMIN)
  @Get()
  list() { return this.payments.list(); }

  @Roles(Role.ADMIN)
  @Get(':id/receipt')
  receipt(@Param('id') id: string) { return this.payments.receipt(+id); }
}
