"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ResponsiveTable } from "@/components/MobileNav";
import {
  Filter,
  SortAsc,
  SortDesc,
  Download,
  Calendar,
  X,
} from "lucide-react";

export type EscrowStatus = "Funded" | "Disbursed" | "Refunded" | "Disputed";

export const ESCROW_STATUSES: EscrowStatus[] = [
  "Funded",
  "Disbursed",
  "Refunded",
  "Disputed",
];

export const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export interface EscrowRow {
  id: string;
  recipient: string;
  token: string;
  amount: number;
  status: EscrowStatus;
  createdAt: string;
}

export interface EscrowFilters {
  search: string;
  status: EscrowStatus | "All";
  dateFrom: string;
  dateTo: string;
}

export interface EscrowSort {
  field: "amount" | "date";
  dir: "asc" | "desc";
}

export const DEFAULT_FILTERS: EscrowFilters = {
  search: "",
  status: "All",
  dateFrom: "",
  dateTo: "",
};

export const DEFAULT_SORT: EscrowSort = { field: "date", dir: "desc" };

export function formatDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export function filterEscrows(rows: EscrowRow[], filters: EscrowFilters): EscrowRow[] {
  const term = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    const matchSearch =
      !term ||
      row.id.toLowerCase().includes(term) ||
      row.recipient.toLowerCase().includes(term) ||
      row.token.toLowerCase().includes(term);
    const matchStatus = filters.status === "All" || row.status === filters.status;
    const rowDate = formatDate(row.createdAt);
    const matchFrom = !filters.dateFrom || rowDate >= filters.dateFrom;
    const matchTo = !filters.dateTo || rowDate <= filters.dateTo;
    return matchSearch && matchStatus && matchFrom && matchTo;
  });
}

export function sortEscrows(rows: EscrowRow[], sort: EscrowSort): EscrowRow[] {
  return [...rows].sort((a, b) => {
    let av: number | string;
    let bv: number | string;
    if (sort.field === "amount") {
      av = a.amount;
      bv = b.amount;
    } else {
      av = new Date(a.createdAt).getTime();
      bv = new Date(b.createdAt).getTime();
    }
    if (av < bv) return sort.dir === "asc" ? -1 : 1;
    if (av > bv) return sort.dir === "asc" ? 1 : -1;
    return 0;
  });
}

export function paginateEscrows(rows: EscrowRow[], page: number, pageSize: number): EscrowRow[] {
  const start = Math.max(0, page - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

export function escrowRowsToCsv(rows: EscrowRow[]): string {
  const header = "ID,Recipient,Token,Amount,Status,Created At";
  const escape = (value: string): string =>
    value.includes(",") || value.includes('"') || value.includes("\n")
      ? `"${value.replace(/"/g, '""')}"`
      : value;
  const lines = [
    header,
    ...rows.map(
      (row) =>
        `${escape(row.id)},${escape(row.recipient)},${escape(row.token)},${row.amount},${escape(row.status)},${escape(row.createdAt)}`
    ),
  ];
  return lines.join("\n");
}

export function downloadCsv(content: string, filename: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function statusBadgeClass(status: EscrowStatus): string {
  switch (status) {
    case "Funded":
      return "bg-primary/10 text-primary border border-primary/20";
    case "Disbursed":
      return "bg-primary/10 text-primary border border-primary/20";
    case "Refunded":
      return "bg-secondary/10 text-secondary-foreground border border-secondary/20";
    case "Disputed":
      return "bg-destructive/10 text-destructive border border-destructive/20";
  }
}

export interface EscrowTableProps {
  data?: EscrowRow[];
  pageSize?: PageSize;
}

export function EscrowTable({ data = [], pageSize: initialPageSize = 10 }: EscrowTableProps) {
  const [filters, setFilters] = React.useState<EscrowFilters>({ ...DEFAULT_FILTERS });
  const [sort, setSort] = React.useState<EscrowSort>({ ...DEFAULT_SORT });
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState<PageSize>(
    PAGE_SIZE_OPTIONS.includes(initialPageSize) ? initialPageSize : 10
  );

  const filtered = filterEscrows(data, filters);
  const sorted = sortEscrows(filtered, sort);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const currentRows = paginateEscrows(sorted, currentPage, pageSize);

  const setSearch = (value: string) => setFilters((prev) => ({ ...prev, search: value }));
  const setStatus = (value: EscrowStatus | "All") =>
    setFilters((prev) => ({ ...prev, status: value }));
  const setDateFrom = (value: string) =>
    setFilters((prev) => ({ ...prev, dateFrom: value }));
  const setDateTo = (value: string) =>
    setFilters((prev) => ({ ...prev, dateTo: value }));

  const clearFilters = () => {
    setFilters({ ...DEFAULT_FILTERS });
    setPage(1);
  };

  const handleSort = (field: "amount" | "date") => {
    setSort((prev) =>
      prev.field === field && prev.dir === "asc"
        ? { field, dir: "desc" }
        : { field, dir: "asc" }
    );
  };

  const handleExport = () => {
    const csv = escrowRowsToCsv(sorted);
    downloadCsv(csv, "escrows.csv");
  };

  const activeFilterCount =
    (filters.search.trim().length > 0 ? 1 : 0) +
    (filters.status !== "All" ? 1 : 0) +
    (filters.dateFrom.length > 0 ? 1 : 0) +
    (filters.dateTo.length > 0 ? 1 : 0);

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <CardTitle>Escrow Dashboard</CardTitle>
            <CardDescription>
              Search, filter, sort, paginate, and export escrow records.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              placeholder="Escrow ID, recipient, or token..."
              aria-label="Search escrows by ID, recipient, or token"
              value={filters.search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-64 text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearFilters}
              disabled={activeFilterCount === 0}
              aria-label="Clear all filters"
              className="text-xs"
            >
              <X className="w-3 h-3 mr-1" aria-hidden="true" /> Clear
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ResponsiveTable label="Escrow records" className="border-b border-border">
          <table className="w-full text-sm text-left border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <th scope="col" className="px-4 py-3">Escrow ID</th>
                <th scope="col" className="px-4 py-3">Recipient</th>
                <th scope="col" className="px-4 py-3">Token</th>
                <th
                  scope="col"
                  className="px-4 py-3 text-right"
                  aria-sort={sort.field === "amount" ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("amount")}
                    aria-label={`Sort by amount (${sort.field === "amount" && sort.dir === "asc" ? "descending" : "ascending"})`}
                    className="inline-flex items-center gap-1 text-foreground hover:text-primary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                  >
                    Amount
                    {sort.field === "amount" && (
                      sort.dir === "asc" ? <SortAsc className="w-3 h-3" aria-hidden="true" /> : <SortDesc className="w-3 h-3" aria-hidden="true" />
                    )}
                  </button>
                </th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th
                  scope="col"
                  className="px-4 py-3"
                  aria-sort={sort.field === "date" ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    onClick={() => handleSort("date")}
                    aria-label={`Sort by created date (${sort.field === "date" && sort.dir === "asc" ? "descending" : "ascending"})`}
                    className="inline-flex items-center gap-1 text-foreground hover:text-primary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                  >
                    Created
                    {sort.field === "date" && (
                      sort.dir === "asc" ? <SortAsc className="w-3 h-3" aria-hidden="true" /> : <SortDesc className="w-3 h-3" aria-hidden="true" />
                    )}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {currentRows.map((row) => (
                <tr key={row.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{row.id}</td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground">
                    {row.recipient.slice(0, 6)}...{row.recipient.slice(-4)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-foreground">{row.token}</td>
                  <td className="px-4 py-3 text-xs font-mono text-right text-foreground">
                    {row.amount.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span
                      className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${statusBadgeClass(row.status)}`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {formatDate(row.createdAt)}
                  </td>
                </tr>
              ))}
              {currentRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-xs text-muted-foreground">
                    No escrow records match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ResponsiveTable>

        <div className="border-t border-border bg-muted/40 p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
          <div className="flex items-center gap-3">
            <Filter className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">
              {activeFilterCount > 0
                ? `${activeFilterCount} filter(s) active`
                : "All statuses"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span id="escrow-status-filter-label" className="text-muted-foreground">Status</span>
            <div role="group" aria-labelledby="escrow-status-filter-label" className="flex gap-1">
              <button
                type="button"
                aria-pressed={filters.status === "All"}
                onClick={() => setStatus("All")}
                className={`px-2 py-1 rounded border text-[10px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  filters.status === "All"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-input border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                All
              </button>
              {ESCROW_STATUSES.map((status) => (
                <button
                  type="button"
                  key={status}
                  aria-pressed={filters.status === status}
                  onClick={() => setStatus(status)}
                  className={`px-2 py-1 rounded border text-[10px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    filters.status === status
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-input border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Calendar className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
            <label htmlFor="escrow-date-from" className="text-muted-foreground">From</label>
            <Input
              id="escrow-date-from"
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-28 h-8 px-2 text-xs"
            />
            <label htmlFor="escrow-date-to" className="text-muted-foreground">To</label>
            <Input
              id="escrow-date-to"
              type="date"
              value={filters.dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-28 h-8 px-2 text-xs"
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="escrow-page-size" className="text-muted-foreground">Page size</label>
            <select
              id="escrow-page-size"
              value={pageSize}
              onChange={(e) => {
                const selected = PAGE_SIZE_OPTIONS.find((s) => String(s) === e.target.value);
                if (selected) {
                  setPageSize(selected);
                  setPage(1);
                }
              }}
              className="w-20 h-8 rounded border border-border bg-input px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
            Showing <b>{currentRows.length}</b> of <b>{sorted.length}</b> record(s) &nbsp;•&nbsp;
            Page <b>{currentPage}</b> of <b>{totalPages}</b>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              aria-label="Previous page"
              className="px-2 py-1 rounded border border-border bg-input text-xs text-foreground disabled:opacity-50 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              aria-label="Next page"
              className="px-2 py-1 rounded border border-border bg-input text-xs text-foreground disabled:opacity-50 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Next
            </button>
          </div>

          <Button type="button" variant="outline" size="sm" onClick={handleExport} className="text-xs">
            <Download className="w-3 h-3 mr-1" aria-hidden="true" /> Export CSV
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
