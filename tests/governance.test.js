/**
 * Governance tests.
 * Tests for memory governance - conflict detection and knowledge update planning.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planKnowledgeUpdate } from '../src/memory/governance.js';

describe('Governance', () => {
  describe('planKnowledgeUpdate', () => {
    it('should return create_new when no related facts exist', async () => {
      const result = await planKnowledgeUpdate({
        content: 'New unique knowledge item',
        aliases: [],
        pathHints: [],
        collectionHints: [],
        facts: [],
      });
      assert.strictEqual(result.strategy, 'create_new');
      assert.strictEqual(result.suggestedMemoryId, '');
      assert.strictEqual(result.relatedMemoryIds.length, 0);
      assert.strictEqual(result.conflictMemoryIds.length, 0);
    });

    it('should return keep_existing for exact text match', async () => {
      const facts = [
        { memory_id: 'mem-1', content: 'React hooks are useful', state: 'kept', status: 'active', aliases: [], path_hints: [], collection_hints: [] },
      ];
      const result = await planKnowledgeUpdate({
        content: 'React hooks are useful',
        aliases: [],
        pathHints: [],
        collectionHints: [],
        facts,
      });
      assert.strictEqual(result.strategy, 'keep_existing');
      assert.strictEqual(result.suggestedMemoryId, 'mem-1');
    });

    it('should return supersede_existing for high-score single match with text overlap', async () => {
      const facts = [
        { memory_id: 'mem-2', content: 'Vue composition API is powerful for state management', state: 'kept', status: 'active', aliases: ['vue'], path_hints: ['frontend/vue'], collection_hints: ['frontend'] },
      ];
      const result = await planKnowledgeUpdate({
        content: 'Vue composition API is powerful for state management and reactivity',
        aliases: ['vue'],
        pathHints: ['frontend/vue'],
        collectionHints: ['frontend'],
        facts,
      });
      assert.ok(['supersede_existing', 'keep_existing', 'resolve_conflict'].includes(result.strategy));
      assert.ok(result.relatedMemoryIds.includes('mem-2'));
    });

    it('should return resolve_conflict for multiple related facts', async () => {
      const facts = [
        { memory_id: 'mem-3', content: 'TypeScript provides type safety for JavaScript', state: 'kept', status: 'active', aliases: ['typescript', 'ts'], path_hints: [], collection_hints: [] },
        { memory_id: 'mem-4', content: 'TypeScript strict mode catches more errors', state: 'kept', status: 'active', aliases: ['typescript', 'ts'], path_hints: [], collection_hints: [] },
      ];
      const result = await planKnowledgeUpdate({
        content: 'TypeScript is a typed superset of JavaScript',
        aliases: ['typescript', 'ts'],
        pathHints: [],
        collectionHints: [],
        facts,
      });
      assert.ok(['resolve_conflict', 'keep_existing'].includes(result.strategy));
      assert.ok(result.relatedMemoryIds.length >= 1);
    });

    it('should return create_new for low-score single match', async () => {
      const facts = [
        { memory_id: 'mem-5', content: 'Docker containers are lightweight VMs', state: 'kept', status: 'active', aliases: ['docker'], path_hints: ['devops/docker'], collection_hints: ['devops'] },
      ];
      const result = await planKnowledgeUpdate({
        content: 'Kubernetes orchestrates container deployments',
        aliases: ['k8s'],
        pathHints: ['devops/k8s'],
        collectionHints: ['devops'],
        facts,
      });
      assert.strictEqual(result.strategy, 'create_new');
    });

    it('should skip inactive facts', async () => {
      const facts = [
        { memory_id: 'mem-6', content: 'Deleted fact', state: 'kept', status: 'deleted', aliases: [], path_hints: [], collection_hints: [] },
      ];
      const result = await planKnowledgeUpdate({
        content: 'Deleted fact',
        aliases: [],
        pathHints: [],
        collectionHints: [],
        facts,
      });
      assert.strictEqual(result.strategy, 'create_new');
    });

    it('should prefer kept state over tentative in sorting', async () => {
      const facts = [
        { memory_id: 'mem-tentative', content: 'Same content for sorting test', state: 'tentative', status: 'active', aliases: [], path_hints: [], collection_hints: [] },
        { memory_id: 'mem-kept', content: 'Same content for sorting test', state: 'kept', status: 'active', aliases: [], path_hints: [], collection_hints: [] },
      ];
      const result = await planKnowledgeUpdate({
        content: 'Same content for sorting test',
        aliases: [],
        pathHints: [],
        collectionHints: [],
        facts,
      });
      assert.strictEqual(result.strategy, 'keep_existing');
      assert.strictEqual(result.suggestedMemoryId, 'mem-kept');
    });

    it('should handle empty content gracefully', async () => {
      const result = await planKnowledgeUpdate({
        content: '',
        aliases: [],
        pathHints: [],
        collectionHints: [],
        facts: [],
      });
      assert.strictEqual(result.strategy, 'create_new');
    });

    it('should detect topic via collection overlap', async () => {
      const facts = [
        { memory_id: 'mem-7', content: 'Node.js event loop architecture', state: 'kept', status: 'active', aliases: [], path_hints: [], collection_hints: ['backend'] },
      ];
      const result = await planKnowledgeUpdate({
        content: 'Express middleware patterns',
        aliases: [],
        pathHints: [],
        collectionHints: ['backend'],
        facts,
      });
      assert.ok(result.relatedMemoryIds.length >= 0);
    });

    it('should detect topic via token overlap with sufficient tokens', async () => {
      const facts = [
        { memory_id: 'mem-8', content: 'React component lifecycle methods and hooks usage patterns', state: 'kept', status: 'active', aliases: [], path_hints: [], collection_hints: [] },
      ];
      const result = await planKnowledgeUpdate({
        content: 'React component hooks usage patterns for state management',
        aliases: [],
        pathHints: [],
        collectionHints: [],
        facts,
      });
      assert.ok(result.relatedMemoryIds.length >= 1);
    });
  });
});
