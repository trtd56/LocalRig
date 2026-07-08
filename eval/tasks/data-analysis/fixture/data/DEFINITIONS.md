# Revenue analysis rules

1. Count only `completed` orders whose `account_type` is not `test`.
2. If an order ID occurs more than once, keep the earliest row by `created_at`.
   Every later occurrence is one excluded input row.
3. Gross revenue is the sum of `amount` for valid orders.
4. Apply a refund only when its order is valid. Refunds may be partial.
5. Net revenue is gross revenue minus valid refunds.
6. Product refund rate is valid refunded amount divided by valid gross amount for
   that product. Round only the displayed percentage to two decimal places.
7. `excluded_rows` counts excluded rows from orders.csv (not refund rows).
