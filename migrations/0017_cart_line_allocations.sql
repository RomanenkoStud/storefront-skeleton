-- Merged duplicate listing. A line for a merged product may be filled by several suppliers.
-- PRIVATE (staff only), like the other supplier columns: JSON [{productId,supplierId,supplierName,externalProductId,
-- variantIds,quantity,unitCostMinor}] in fill order. NULL for ordinary lines. The single-supplier columns hold the first part.
ALTER TABLE cart_lines ADD COLUMN allocations_json TEXT;
