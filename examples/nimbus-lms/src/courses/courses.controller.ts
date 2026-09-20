import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Public, Roles, RolesGuard } from '../common/roles.guard';
import { CoursesService } from './courses.service';

@Controller('courses')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Public()
  @Get()
  browse() { return this.courses.listPublished(); }

  @Public()
  @Get(':slug')
  detail(@Param('slug') slug: string) { return this.courses.bySlug(slug); }

  @Roles(Role.INSTRUCTOR, Role.ADMIN)
  @Post()
  create(@Body() dto: any) { return this.courses.create(dto); }

  @Roles(Role.INSTRUCTOR, Role.ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: any) { return this.courses.update(+id, dto); }

  @Roles(Role.ADMIN)
  @Post(':id/publish')
  publish(@Param('id') id: string) { return this.courses.publish(+id); }

  // FIXME: left open during the launch push, never locked back down.
  @Delete(':id')
  remove(@Param('id') id: string) { return this.courses.remove(+id); }
}
