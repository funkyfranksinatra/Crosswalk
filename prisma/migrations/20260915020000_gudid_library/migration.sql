-- AlterTable
ALTER TABLE "OwnProduct" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'seed';

-- CreateTable
CREATE TABLE "GudidDevice" (
    "id" TEXT NOT NULL,
    "recordKey" TEXT NOT NULL,
    "primaryDi" TEXT,
    "labeler" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "catalogNumber" TEXT,
    "versionModel" TEXT,
    "cfnNorm" TEXT,
    "cfnCompact" TEXT,
    "brand" TEXT,
    "description" TEXT,
    "gmdnName" TEXT,
    "gmdnCode" TEXT,
    "fdaProductCode" TEXT,
    "status" TEXT,
    "family" TEXT,
    "sizesJson" TEXT,
    "singleUse" BOOLEAN,
    "sterile" BOOLEAN,
    "implantable" BOOLEAN,
    "gudidJson" TEXT NOT NULL,
    "publishDate" TEXT,
    "versionDate" TEXT,
    "importId" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GudidDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GudidImport" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "addToOwnCatalog" BOOLEAN NOT NULL DEFAULT false,
    "familiesJson" TEXT,
    "productCodesJson" TEXT,
    "inDistributionOnly" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "expected" INTEGER,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "ownAdded" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "log" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "GudidImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GudidDevice_recordKey_key" ON "GudidDevice"("recordKey");

-- CreateIndex
CREATE INDEX "GudidDevice_cfnNorm_idx" ON "GudidDevice"("cfnNorm");

-- CreateIndex
CREATE INDEX "GudidDevice_cfnCompact_idx" ON "GudidDevice"("cfnCompact");

-- CreateIndex
CREATE INDEX "GudidDevice_primaryDi_idx" ON "GudidDevice"("primaryDi");

-- CreateIndex
CREATE INDEX "GudidDevice_manufacturer_idx" ON "GudidDevice"("manufacturer");

-- CreateIndex
CREATE INDEX "GudidDevice_brand_idx" ON "GudidDevice"("brand");

-- AddForeignKey
ALTER TABLE "GudidDevice" ADD CONSTRAINT "GudidDevice_importId_fkey" FOREIGN KEY ("importId") REFERENCES "GudidImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GudidImport" ADD CONSTRAINT "GudidImport_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

