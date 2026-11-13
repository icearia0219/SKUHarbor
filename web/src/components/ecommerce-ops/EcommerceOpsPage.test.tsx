// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EcommerceOpsPage } from '../../pages/EcommerceOpsPage';
import { ReviewPanel } from './ReviewPanel';
import {
  ecomRequest,
  useEcommerceAvailability,
  useEcommerceOpsStore,
} from '../../stores/ecommerce-ops';
import { productNavItems } from '../layout/nav-items';
import { Field } from './shared';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));
vi.mock('../../api/client', () => ({ api: mocks }));
vi.mock('../../stores/groups', () => ({
  useGroupsStore: (selector: (state: unknown) => unknown) =>
    selector({
      groups: { 'web:shop-a': { name: '店铺 A', folder: 'shop-a' } },
      loadGroups: vi.fn(async () => undefined),
    }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter>{node}</MemoryRouter>));
}
beforeEach(() => {
  vi.clearAllMocks();
  useEcommerceAvailability.setState({
    enabled: false,
    checked: false,
    loading: false,
  });
  useEcommerceOpsStore.setState({
    workspaceId: '',
    data: null,
    loading: false,
    error: null,
  });
  mocks.get.mockImplementation(async (path: string) =>
    path.includes('availability')
      ? { enabled: true }
      : {
          products: [
            {
              id: 'product-a',
              sku: 'SKU-A',
              market: 'US',
              locale: 'en-US',
              revision: 1,
              facts: [],
            },
          ],
          assets: [],
          knowledge: [],
          tasks: [],
          artifacts: [],
          reports: [],
        },
  );
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
});
test('disabled direct route has no writable controls or workspace requests', async () => {
  mocks.get.mockResolvedValue({ enabled: false });
  await render(<EcommerceOpsPage />);
  await vi.waitFor(() =>
    expect(container.textContent).toContain('电商运营尚未开启'),
  );
  expect(container.querySelector('form')).toBeNull();
  expect(
    mocks.get.mock.calls.every(([path]) => path.includes('availability')),
  ).toBe(true);
  expect(mocks.post).not.toHaveBeenCalled();
});
test('workspace selection sends the authorized JID and renders returned products', async () => {
  await render(<EcommerceOpsPage />);
  const select = await vi.waitFor(() => {
    const field =
      container.querySelector<HTMLSelectElement>('[aria-label="工作区"]');
    expect(field).not.toBeNull();
    return field!;
  });
  await act(async () => {
    select.value = 'web:shop-a';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await vi.waitFor(() => expect(container.textContent).toContain('SKU-A'));
  expect(mocks.get).toHaveBeenCalledWith(
    '/api/ecommerce-ops/workspace?workspace_id=web%3Ashop-a',
  );
});
test('stale artifact keeps preview available but prevents approval and approved export', async () => {
  await render(
    <ReviewPanel
      artifact={{
        id: 'artifact-a',
        task_id: 'task-a',
        revision: 3,
        content_hash: 'exact-hash',
        stale: true,
        result: { status: 'draft', payload: { title: 'Draft' } },
        quality: [],
        review: null,
      }}
      workspaceId="web:shop-a"
      onChange={vi.fn()}
    />,
  );
  expect(container.textContent).toContain('已失效');
  expect(container.textContent).toContain('exact-hash');
  const approve = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('通过审核'),
  );
  expect(approve?.disabled).toBe(true);
  expect(
    container.querySelector('[data-export-approved]')?.getAttribute('disabled'),
  ).not.toBeNull();
});
test('feature gate hides navigation and rejects writes even when called outside the page', async () => {
  expect(
    productNavItems(false).some((item) => item.path === '/ecommerce-ops'),
  ).toBe(false);
  expect(
    productNavItems(false, 'OpenDot', true).some(
      (item) => item.path === '/ecommerce-ops',
    ),
  ).toBe(true);
  await expect(
    ecomRequest('web:shop-a', '/tasks', { task_type: 'listing_pack' }),
  ).rejects.toThrow('请先开启');
  expect(mocks.post).not.toHaveBeenCalled();
});
test('select labels name only the field and point to its single control', async () => {
  await render(
    <Field label="任务类型">
      <select>
        <option>Listing</option>
        <option>客服草稿</option>
      </select>
    </Field>,
  );
  const label = container.querySelector('label')!,
    select = container.querySelector('select')!;
  expect(label.textContent).toBe('任务类型');
  expect(label.htmlFor).toBe(select.id);
  expect(select.id).not.toBe('');
});
test('approval submits the displayed revision and hash without claiming a local approval', async () => {
  useEcommerceAvailability.setState({ enabled: true, checked: true });
  const onChange = vi.fn();
  mocks.post.mockResolvedValue({});
  await render(
    <ReviewPanel
      artifact={{
        id: 'artifact-a',
        task_id: 'task-a',
        revision: 7,
        content_hash: 'hash-v7',
        stale: false,
        result: { status: 'draft', payload: { title: 'Draft' } },
        quality: [],
        review: null,
      }}
      workspaceId="web:shop-a"
      onChange={onChange}
    />,
  );
  const reason = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(reason, '已核对本SKU证据');
    reason.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const approve = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '通过审核',
  )!;
  expect(approve.disabled).toBe(false);
  await act(async () => approve.click());
  expect(mocks.post).toHaveBeenCalledWith(
    '/api/ecommerce-ops/artifacts/artifact-a/review',
    expect.objectContaining({
      workspace_id: 'web:shop-a',
      expected_revision: 7,
      content_hash: 'hash-v7',
      decision: 'approve',
      reason: '已核对本SKU证据',
    }),
  );
  expect(onChange).toHaveBeenCalledOnce();
  expect(
    container.querySelector<HTMLButtonElement>('[data-export-approved]')!
      .disabled,
  ).toBe(true);
});
test('opening an editor blocks previously approved export until the server validates a new version', async () => {
  useEcommerceAvailability.setState({ enabled: true, checked: true });
  await render(
    <ReviewPanel
      artifact={{
        id: 'artifact-a',
        task_id: 'task-a',
        revision: 2,
        content_hash: 'hash-v2',
        stale: false,
        result: { status: 'draft', payload: { title: 'Approved title' } },
        quality: [],
        review: { decision: 'approve', valid: true },
      }}
      workspaceId="web:shop-a"
      onChange={vi.fn()}
    />,
  );
  expect(
    container.querySelector<HTMLButtonElement>('[data-export-approved]')!
      .disabled,
  ).toBe(false);
  const edit = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '编辑内容',
  )!;
  await act(async () => edit.click());
  expect(
    container.querySelector<HTMLButtonElement>('[data-export-approved]')!
      .disabled,
  ).toBe(true);
  expect(mocks.patch).not.toHaveBeenCalled();
  mocks.patch.mockResolvedValue({});
  const save = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '保存修改并重新质检',
  )!;
  await act(async () => save.click());
  expect(mocks.patch).toHaveBeenCalledWith(
    '/api/ecommerce-ops/artifacts/artifact-a',
    expect.objectContaining({
      expected_revision: 2,
      workspace_id: 'web:shop-a',
    }),
  );
  expect(
    container.querySelector<HTMLButtonElement>('[data-export-approved]')!
      .disabled,
  ).toBe(true);
});
test('late workspace responses never replace the selected workspace data', async () => {
  useEcommerceAvailability.setState({ enabled: true, checked: true });
  let resolveFirst!: (data: unknown) => void;
  mocks.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  mocks.get.mockResolvedValueOnce({
    products: [],
    assets: [],
    knowledge: [],
    tasks: [],
    artifacts: [],
    reports: [],
  });
  const first = useEcommerceOpsStore.getState().load('web:shop-a');
  await useEcommerceOpsStore.getState().load('web:shop-b');
  resolveFirst({ products: [{ id: 'private-a' }] });
  await first;
  expect(useEcommerceOpsStore.getState().workspaceId).toBe('web:shop-b');
  expect(useEcommerceOpsStore.getState().data?.products).toEqual([]);
});
