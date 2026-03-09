import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class VentaListener {
  @OnEvent('venta.creada', { async: true }) // async: true = no bloquea
  async handleVentaCreada(payload: { sistema_url: string; mensaje: string }) {
    try {
      await axios.post(
        `http://147.79.107.102:4009/sistema-control/api/bot-telegram`,
        {
          sistema_url: payload.sistema_url,
          mensaje: payload.mensaje,
        },
        {
          auth: {
            username: process.env.WSP_USER,
            password: process.env.WSP_PASS,
          },
        },
      );
      console.log('✅ WhatsApp enviado por EventEmitter');
    } catch (error) {
      console.error('❌ Error enviando WhatsApp:', error.message);
    }
  }
}
