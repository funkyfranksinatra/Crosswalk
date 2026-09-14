-- CreateTable
CREATE TABLE "CompetitorSpec" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cfnNorm" TEXT NOT NULL,
    "manufacturer" TEXT,
    "description" TEXT,
    "dimsJson" TEXT NOT NULL,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'import',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorSpec_cfnNorm_key" ON "CompetitorSpec"("cfnNorm");
