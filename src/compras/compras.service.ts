import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import * as moment from 'moment-timezone';

import { CreateCompraDto } from './dto/create-compra.dto';
import { UpdateCompraDto } from './dto/update-compra.dto';
import { InventarioService } from 'src/inventario/inventario.service';
import { Almacen } from 'src/almacenes/entities/almacen.entity';
import { Compra } from './entities/compra.entity';
import { Inventario } from 'src/inventario/entities/inventario.entity';
import { MovimientosAlmacenService } from 'src/inventario/service/movimientos-almacen.service';
import { DetalleCompra } from './entities/detalle-compra.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { ProductosService } from 'src/productos/productos.service';

@Injectable()
export class ComprasService {
  constructor(
    @InjectRepository(Compra)
    private readonly compraRepository: Repository<Compra>,
    @InjectRepository(DetalleCompra)
    private readonly detallesRepository: Repository<DetalleCompra>,
    private readonly dataSource: DataSource,
    private readonly inventarioService: InventarioService,
    private readonly movimientosService: MovimientosAlmacenService,
    private readonly productoService: ProductosService,

  ) { }
  async create(createCompraDto: CreateCompraDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const { detalles, almacen, fecha, glosa, user } = createCompraDto;

      const almaceDestino = await queryRunner.manager.findOne(Almacen, { where: { id: almacen } });

      if (!almaceDestino) {
        throw new NotFoundException('No se encuentra el Almacén');
      }

      // Crear la compra, pero aún no guardar los detalles
      const compraNueva: Compra = queryRunner.manager.create(Compra, {
        responsable: { id: user },
        almacen: { id: almaceDestino.id },
        fecha,
        glosa,
      });

      // Guardar la compra para obtener el ID
      const compraGuardada = await queryRunner.manager.save(Compra, compraNueva);


      // Procesar los detalles
      for (const element of detalles) {
        const inventario = await queryRunner.manager.findOne(Inventario, {
          where: { product: { id: element.id_producto } },
          relations: ['product'],
        });

        if (!inventario) {
          throw new NotFoundException('No se encontró el inventario');
        }

        const cantidadCompra = Number(element.cantidad);
        const precioCompra = Number(element.precioCompra);

        const stockActual = Number(inventario.stock);
        const costoActual = Number(inventario.costoUnit ?? 0);

        const nuevoStock = stockActual + cantidadCompra;

        const nuevoCostoUnit =
          nuevoStock === 0
            ? precioCompra
            : (
              (stockActual * costoActual) +
              (cantidadCompra * precioCompra)
            ) / nuevoStock;


        // 🔹 MOVIMIENTO DE INGRESO (con costo congelado)
        const inventarioI = await this.inventarioService.agregarStockTransaccional(
          {
            almacenId: almaceDestino.id,
            cantidad: cantidadCompra,
            productoId: inventario.product.id,
            sku: element.sku,
            costoUnit: nuevoCostoUnit,
            fechaExpiracion: moment(element.fecha_expiracion).tz("America/La_Paz").toDate(),
          },
          queryRunner,
        );


        // 🔹 MOVIMIENTO DE INGRESO (con costo congelado)
        await this.movimientosService.registrarIngresoTransaccional(
          {
            almacenId: almaceDestino.id,
            cantidad: cantidadCompra,
            productoId: inventario.product.id,
            descripcion: 'Ingreso por compra',
            sku: element.sku,
            costoUnit: nuevoCostoUnit,
            inventario: inventarioI
          },
          queryRunner,
        );

        // 🔹 DETALLE DE COMPRA
        const detalleCompra = queryRunner.manager.create(DetalleCompra, {
          inventario,
          cantidad: cantidadCompra,
          precioCompra,
          precioMinVenta: element.precioMinVenta,
          precioVenta: element.precioVenta,
          fechaExpiracion: element.fecha_expiracion,
          sku: element.sku,
          compra: compraGuardada,
        });

        await queryRunner.manager.save(detalleCompra);

        // 🔹 ACTUALIZAR PRECIOS DE VENTA (opcional)
        await this.productoService.cambiarPrecioProductoTransaccion(
          inventario.product.id,
          element.precioVenta,
          element.precioMinVenta,
          queryRunner,
        );
      }


      await queryRunner.commitTransaction();
    } catch (error) {

      console.error(error);
      await queryRunner.rollbackTransaction();
      throw new InternalServerErrorException('No se pudo crear el traspaso');
    } finally {
      await queryRunner.release(); // Liberar el QueryRunner
    }
  }

  async findAll() {
    return this.compraRepository.find({ relations: ['almacen', 'responsable', 'detalles', 'detalles.inventario',] })
  }

  async findOne(id: string) {
    const compra = await this.compraRepository.findOne({ where: { id: id }, relations: ['almacen', 'responsable', 'detalles', 'detalles.inventario', 'detalles.inventario.product'] });

    if (!compra) {
      throw new NotFoundException('La compra no fue encontrada');
    }

    return compra;
  }

  async update(id: string, updateCompraDto: UpdateCompraDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const { detalles, fecha, glosa, almacen } = updateCompraDto;

      const compra = await queryRunner.manager.findOne(Compra, {
        where: { id },
        relations: [
          'detalles',
          'detalles.inventario',
          'detalles.inventario.product',
          'almacen',
        ],
      });

      if (!compra) {
        throw new NotFoundException('Compra no encontrada');
      }

      const almacenAnteriorId = compra.almacen.id;
      const almacenNuevoId = almacen ?? almacenAnteriorId;
      const cambioAlmacen = almacenNuevoId !== almacenAnteriorId;

      // =====================================================
      // 🔹 ACTUALIZAR CABECERA
      // =====================================================
      compra.fecha = fecha;
      compra.glosa = glosa;

      // =====================================================
      // 🔁 CAMBIO DE ALMACÉN (traslado total)
      // =====================================================
      if (cambioAlmacen) {
        for (const detalle of compra.detalles) {
          const inv = detalle.inventario;

          const inventarioS = await this.inventarioService.descontarStockTransaccional(
            {
              almacenId: almacenAnteriorId,
              cantidad: Number(detalle.cantidad),
              productoId: inv.product.id,
              sku: inv.sku,
              fechaExpiracion: inv.fechaExpiracion,
              costoUnit: inv.costoUnit
            },
            queryRunner,
          );

          await this.movimientosService.registrarSalidaTransaccional(
            {
              almacenId: almacenAnteriorId,
              cantidad: Number(detalle.cantidad),
              productoId: inv.product.id,
              descripcion: 'Salida por cambio de almacén en compra',
              sku: inv.sku,
              costoUnit: inv.costoUnit,
              inventario: inventarioS
            },
            queryRunner,
          );
          let costoUnit = inv.costoUnit;
          const inventarioLlegada = await queryRunner.manager.findOne(Inventario, { where: { almacen: { id: almacenNuevoId }, product: { id: inv.product.id } } })
          if (inventarioLlegada && inventarioLlegada.stock > 1) {
            costoUnit =
              (
                inventarioLlegada.stock * inv.costoUnit +
                detalle.cantidad * detalle.precioCompra
              ) / (inventarioLlegada.stock + detalle.cantidad);
          }

          const inventarioI = await this.inventarioService.agregarStockTransaccional(
            {
              almacenId: almacenNuevoId,
              cantidad: Number(detalle.cantidad),
              productoId: inv.product.id,
              sku: inv.sku,
              fechaExpiracion: inv.fechaExpiracion,
              costoUnit
            },
            queryRunner,
          );

          await this.movimientosService.registrarIngresoTransaccional(
            {
              almacenId: almacenNuevoId,
              cantidad: Number(detalle.cantidad),
              productoId: inv.product.id,
              descripcion: 'Ingreso por cambio de almacén en compra',
              sku: inv.sku,
              costoUnit,
              inventario: inventarioI
            },
            queryRunner,
          );
        }

        compra.almacen = { id: almacenNuevoId } as any;
        await queryRunner.manager.save(compra);

        if (!detalles || detalles.length === 0) {
          await queryRunner.commitTransaction();
          return compra;
        }
      }

      // =====================================================
      // 🔹 MAPEAR DETALLES EXISTENTES (por producto)
      // =====================================================
      const detallesMap = new Map(
        compra.detalles.map(d => [d.inventario.product.id, d]),
      );

      // =====================================================
      // 🔹 PROCESAR DETALLES
      // =====================================================
      for (const item of detalles) {
        const detalleExistente = detallesMap.get(item.id_producto);

        const inventario = await queryRunner.manager.findOne(Inventario, {
          where: {
            almacen: { id: compra.almacen.id },
            product: { id: item.id_producto },
          },
          relations: ['product'],
        });

        if (!inventario) {
          throw new NotFoundException('Inventario no encontrado');
        }

        // =====================================================
        // 🔄 DETALLE EXISTENTE
        // =====================================================
        if (detalleExistente) {
          const diferencia =
            Number(item.cantidad) - Number(detalleExistente.cantidad);

          const cambioPrecioCompra =
            item.precioCompra !== detalleExistente.precioCompra;

          const cambioPrecioVenta =
            item.precioVenta !== detalleExistente.precioVenta;

          const cambioPrecioMinVenta =
            item.precioMinVenta !== detalleExistente.precioMinVenta;

          const cambioCodigoBarras =
            item.sku !== detalleExistente.sku;

          const hayCambioPrecio =
            cambioPrecioCompra || cambioPrecioVenta || cambioPrecioMinVenta;

          // 🟡 SOLO CAMBIO DE PRECIOS
          if (diferencia === 0 && hayCambioPrecio) {
            await this.productoService.cambiarPrecioProductoTransaccion(
              inventario.product.id,
              item.precioVenta,
              item.precioMinVenta,
              queryRunner,
            );

            detalleExistente.precioCompra = item.precioCompra;
            detalleExistente.precioVenta = item.precioVenta;
            detalleExistente.precioMinVenta = item.precioMinVenta;

            await queryRunner.manager.save(detalleExistente);
            detallesMap.delete(item.id_producto);
            continue;
          }

          // 🟢 AJUSTE DE STOCK
          if (diferencia > 0) {

            const stockActual = inventario.stock;
            const costoActual = inventario.costoUnit;

            const nuevoStock = stockActual + diferencia;

            const nuevoPPP =
              nuevoStock <= 0
                ? item.precioCompra
                : (
                  stockActual * costoActual +
                  diferencia * item.precioCompra
                ) / nuevoStock;


            const inventarioI = await this.inventarioService.agregarStockTransaccional(
              {
                almacenId: compra.almacen.id,
                cantidad: diferencia,
                productoId: inventario.product.id,
                sku: item.sku,
                fechaExpiracion: moment(item.fecha_expiracion).tz("America/La_Paz").toDate(),
                costoUnit: Number(nuevoPPP.toFixed(4))
              },
              queryRunner,
            );

            await this.movimientosService.registrarIngresoTransaccional(
              {
                almacenId: compra.almacen.id,
                cantidad: diferencia,
                productoId: inventario.product.id,
                descripcion: 'Ajuste positivo por actualización de compra',
                sku: item.sku,
                costoUnit: Number(nuevoPPP.toFixed(4)),
                inventario: inventarioI
              },
              queryRunner,
            );
          }

          if (diferencia < 0) {
            const inventarioS = await this.inventarioService.descontarStockTransaccional(
              {
                almacenId: compra.almacen.id,
                cantidad: Math.abs(diferencia),
                productoId: inventario.product.id,
                sku: inventario.sku,
                fechaExpiracion: inventario.fechaExpiracion,
                costoUnit: inventario.costoUnit,
              },
              queryRunner,
            );

            await this.movimientosService.registrarSalidaTransaccional(
              {
                almacenId: compra.almacen.id,
                cantidad: Math.abs(diferencia),
                productoId: inventario.product.id,
                descripcion: 'Ajuste negativo por actualización de compra',
                sku: inventario.sku,
                costoUnit: inventario.costoUnit,
                inventario: inventarioS
              },
              queryRunner,
            );
          }

          if (cambioCodigoBarras && (diferencia === 0 || diferencia < 0)) {

            inventario.sku = item.sku;
            inventario.fechaExpiracion = moment(item.fecha_expiracion).tz("America/La_Paz").toDate();
            await queryRunner.manager.save(inventario)
          }

          // 🟣 CAMBIO DE PRECIOS + STOCK
          if (hayCambioPrecio) {
            await this.productoService.cambiarPrecioProductoTransaccion(
              inventario.product.id,
              item.precioVenta,
              item.precioMinVenta,
              queryRunner,
            );
          }

          detalleExistente.cantidad = item.cantidad;
          detalleExistente.precioCompra = item.precioCompra;
          detalleExistente.precioVenta = item.precioVenta;
          detalleExistente.precioMinVenta = item.precioMinVenta;
          detalleExistente.sku = item.sku;
          detalleExistente.fechaExpiracion = moment(item.fecha_expiracion).tz("America/La_Paz").toDate();

          await queryRunner.manager.save(detalleExistente);
          detallesMap.delete(item.id_producto);
        }

        // =====================================================
        // ➕ NUEVO DETALLE
        // =====================================================
        else {

          const cantidadCompra = Number(item.cantidad);
          const precioCompra = Number(item.precioCompra);

          const stockActual = Number(inventario.stock);
          const costoActual = Number(inventario.costoUnit ?? 0);

          const nuevoStock = stockActual + cantidadCompra;

          const nuevoCostoUnit =
            nuevoStock === 0
              ? precioCompra
              : (
                (stockActual * costoActual) +
                (cantidadCompra * precioCompra)
              ) / nuevoStock;

          const inventarioI = await this.inventarioService.agregarStockTransaccional(
            {
              almacenId: compra.almacen.id,
              cantidad: Number(item.cantidad),
              productoId: inventario.product.id,
              sku: inventario.sku,
              fechaExpiracion: inventario.fechaExpiracion,
              costoUnit: nuevoCostoUnit,
            },
            queryRunner,
          );

          await this.movimientosService.registrarIngresoTransaccional(
            {
              almacenId: compra.almacen.id,
              cantidad: Number(item.cantidad),
              productoId: inventario.product.id,
              descripcion:
                'Ingreso por nuevo detalle en actualización de compra',
              sku: inventario.sku,
              costoUnit: nuevoCostoUnit,
              inventario: inventarioI
            },
            queryRunner,
          );

          const nuevoDetalle = queryRunner.manager.create(DetalleCompra, {
            compra,
            inventario,
            cantidad: item.cantidad,
            precioCompra: item.precioCompra,
            precioMinVenta: item.precioMinVenta,
            precioVenta: item.precioVenta,
            sku: item.sku,
            fechaExpiracion: moment(item.fecha_expiracion)
              .tz("America/La_Paz")
              .toDate(),
          });

          await queryRunner.manager.save(nuevoDetalle);
        }
      }

      // =====================================================
      // ❌ DETALLES ELIMINADOS
      // =====================================================
      for (const detalleEliminado of detallesMap.values()) {
        const inv = detalleEliminado.inventario;

        const inventarioS = await this.inventarioService.descontarStockTransaccional(
          {
            almacenId: compra.almacen.id,
            cantidad: Number(detalleEliminado.cantidad),
            productoId: inv.product.id,
            sku: inv.sku,
            fechaExpiracion: inv.fechaExpiracion,
            costoUnit: inv.costoUnit,

          },
          queryRunner,
        );

        await this.movimientosService.registrarSalidaTransaccional(
          {
            almacenId: compra.almacen.id,
            cantidad: Number(detalleEliminado.cantidad),
            productoId: inv.product.id,
            descripcion: 'Salida por eliminación de detalle de compra',
            sku: inv.sku,
            costoUnit: inv.costoUnit,
            inventario: inventarioS
          },
          queryRunner,
        );

        await queryRunner.manager.remove(detalleEliminado);
      }

      await queryRunner.commitTransaction();
      return compra;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new InternalServerErrorException(
        'No se pudo actualizar la compra',
      );
    } finally {
      await queryRunner.release();
    }
  }


  async remove(id: string): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1️⃣ Buscar compra con relaciones
      const compra = await queryRunner.manager.findOne(Compra, {
        where: { id },
        relations: ['almacen', 'detalles', 'detalles.inventario', 'detalles.inventario.product'],
      });

      if (!compra) {
        throw new NotFoundException(`Compra con id ${id} no encontrada`);
      }

      // 2️⃣ Revertir inventario
      for (const detalle of compra.detalles) {
        const inv = detalle.inventario;

        // ➖ Salida de inventario (se devuelve lo ingresado por la compra)
        const inventarioS = await this.inventarioService.descontarStockTransaccional(
          {
            almacenId: compra.almacen.id,
            cantidad: Number(detalle.cantidad),
            productoId: inv.product.id,
            sku: inv.sku,
            fechaExpiracion: inv.fechaExpiracion,
            costoUnit: inv.costoUnit,
          },
          queryRunner,
        );

        // 🧾 Registrar movimiento
        await this.movimientosService.registrarSalidaTransaccional(
          {
            almacenId: compra.almacen.id,
            cantidad: Number(detalle.cantidad),
            productoId: inv.product.id,
            descripcion: 'Salida por eliminación de compra',
            sku: inv.sku,
            costoUnit: inv.costoUnit,
            inventario: inventarioS
          },
          queryRunner,
        );
      }

      // 3️⃣ Eliminar detalles
      await queryRunner.manager.delete(DetalleCompra, {
        compra: { id: compra.id },
      });

      // 4️⃣ Eliminar compra
      await queryRunner.manager.delete(Compra, compra.id);

      // 5️⃣ Confirmar
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

}
