import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Public } from '../common/roles.guard';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: any) { return this.auth.register(dto); }

  @Public()
  @Post('login')
  login(@Body() dto: any) { return this.auth.login(dto); }

  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  me() { return this.auth.me(); }

  @UseGuards(AuthGuard('jwt'))
  @Patch('me/profile')
  updateProfile(@Body() dto: any) { return this.auth.updateProfile(dto); }
}
