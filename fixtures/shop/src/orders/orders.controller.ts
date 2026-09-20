import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles, RolesGuard, Public } from '../common/guards/roles.guard';
import { OrdersService } from './orders.service';
import { Role } from '@prisma/client';

@Controller('orders')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll() { return this.ordersService.findAll(); }

  @Get(':id')
  findOne(@Param('id') id: string) { return this.ordersService.findOne(+id); }

  @Post()
  @Roles(Role.CUSTOMER, Role.MANAGER)
  create(@Body() dto: any) { return this.ordersService.create(dto); }

  @Patch(':id/approve')
  @Roles(Role.MANAGER)
  approve(@Param('id') id: string) { return this.ordersService.approve(+id); }

  @Delete(':id')
  @Roles(Role.ADMIN)
  remove(@Param('id') id: string) { return this.ordersService.remove(+id); }

  @Public()
  @Get('track/:code')
  track(@Param('code') code: string) { return this.ordersService.track(code); }
}
