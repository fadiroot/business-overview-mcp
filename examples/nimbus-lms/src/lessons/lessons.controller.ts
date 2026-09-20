import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles, RolesGuard } from '../common/roles.guard';
import { LessonsService } from './lessons.service';

@Controller('modules/:moduleId/lessons')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class LessonsController {
  constructor(private readonly lessons: LessonsService) {}

  @Get()
  list(@Param('moduleId') moduleId: string) { return this.lessons.list(+moduleId); }

  @Get(':id/stream')
  stream(@Param('id') id: string) { return this.lessons.stream(+id); }

  @Roles(Role.INSTRUCTOR, Role.ADMIN)
  @Post()
  create(@Body() dto: any) { return this.lessons.create(dto); }

  @Roles(Role.INSTRUCTOR, Role.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) { return this.lessons.remove(+id); }
}
