import { Controller, Get, Post, Put, Delete, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Roles, RolesGuard } from '../common/guards/roles.guard';

@Controller('products')
export class ProductsController {
  @Get() list() {}
  @Get(':id') detail() {}
  @Post() @UseGuards(AuthGuard('jwt'), RolesGuard) @Roles('ADMIN', 'MANAGER') create() {}
  @Put(':id') @UseGuards(AuthGuard('jwt')) update() {}
  @Delete(':id') remove() {}
}
