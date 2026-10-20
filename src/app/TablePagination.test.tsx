import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { TablePagination, pageWindow } from './TablePagination';

describe('pageWindow', () => {
  it('lists all pages when they fit', () => {
    expect(pageWindow(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('windows around the current page with ellipses at gaps', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, '…', 20]);
    expect(pageWindow(10, 20)).toEqual([1, '…', 9, 10, 11, '…', 20]);
    expect(pageWindow(20, 20)).toEqual([1, '…', 19, 20]);
  });
});

describe('TablePagination', () => {
  it('renders nothing for a single page', () => {
    const { container } = render(
      <TablePagination page={1} totalPages={1} totalRows={5} itemLabel="rows" onPage={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows page-of-total and numbered buttons with the current page marked', () => {
    render(
      <TablePagination page={2} totalPages={4} totalRows={80} itemLabel="groups" onPage={() => {}} />,
    );
    expect(screen.getByText('Page 2 of 4 · 80 groups')).toBeInTheDocument();
    const current = screen.getByRole('button', { name: '2' });
    expect(current.getAttribute('aria-current')).toBe('page');
  });

  it('prev/next disable at the bounds', () => {
    const { rerender } = render(
      <TablePagination page={1} totalPages={4} totalRows={80} itemLabel="groups" onPage={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
    rerender(
      <TablePagination page={4} totalPages={4} totalRows={80} itemLabel="groups" onPage={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('jumps to the entered page and clamps out-of-range input', () => {
    const onPage = vi.fn();
    render(
      <TablePagination page={2} totalPages={20} totalRows={400} itemLabel="groups" onPage={onPage} />,
    );
    fireEvent.change(screen.getByLabelText('Jump to'), { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onPage).toHaveBeenCalledWith(17);

    fireEvent.change(screen.getByLabelText('Jump to'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onPage).toHaveBeenCalledWith(20);

    fireEvent.change(screen.getByLabelText('Jump to'), { target: { value: 'not-a-number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onPage).toHaveBeenCalledTimes(2);
  });
});
