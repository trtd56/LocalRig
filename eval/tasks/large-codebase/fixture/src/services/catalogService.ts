import { ProductRepository } from "../repository/productRepository";
import { createProduct } from "../domain/product";
import type { Product } from "../domain/types";

/** Manages the product catalog. */
export class CatalogService {
  constructor(private products: ProductRepository) {}

  add(sku: string, name: string, unitPrice: number, category: string): Product {
    const product = createProduct(sku, name, unitPrice, category);
    this.products.save(product);
    return product;
  }

  list(category?: string): Product[] {
    return category ? this.products.byCategory(category) : this.products.all();
  }

  priceOf(sku: string): number {
    const product = this.products.find(sku);
    if (!product) throw new Error(`unknown sku: ${sku}`);
    return product.unitPrice;
  }
}
