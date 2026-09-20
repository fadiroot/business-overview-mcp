import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class CoursesService {
  constructor(private prisma: PrismaService) {}
  listPublished() { return this.prisma.course.findMany({ where: { published: true }, include: { categories: true } }); }
  bySlug(slug: string) { return this.prisma.course.findUnique({ where: { slug }, include: { categories: true, modules: true } }); }
  create(dto: any) { return this.prisma.course.create({ data: dto }); }
  update(id: number, dto: any) { return this.prisma.course.update({ where: { id }, data: dto }); }
  publish(id: number) { return this.prisma.course.update({ where: { id }, data: { published: true } }); }
  remove(id: number) { return this.prisma.course.delete({ where: { id } }); }
}
