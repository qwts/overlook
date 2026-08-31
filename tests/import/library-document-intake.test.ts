import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';

import { LibraryDocumentIntake } from '../../src/main/import/library-document-intake.js';

describe('library document intake (#799)', () => {
  test('holds and deduplicates documents while returning ordinary imports', async () => {
    const intake = new LibraryDocumentIntake();
    const documents: string[] = [];
    assert.deepEqual(intake.enqueue(['Family.overlooklibrary', 'photo.jpg', 'Family.overlooklibrary'], tmpdir()), [
      path.join(tmpdir(), 'photo.jpg'),
    ]);
    assert.equal(intake.hasPending(), true);
    await intake.flush();
    assert.equal(intake.hasPending(), true, 'documents remain queued until a handler is installed');
    await intake.handle((document) => {
      documents.push(document);
      return Promise.resolve();
    });
    assert.deepEqual(documents, [path.join(tmpdir(), 'Family.overlooklibrary')]);
    assert.equal(intake.hasPending(), false);
    await intake.flush();
  });

  test('keeps later documents ordered after a handler rejection', async () => {
    const intake = new LibraryDocumentIntake();
    const attempts: string[] = [];
    intake.enqueue(['First.overlooklibrary'], tmpdir());
    await assert.rejects(
      intake.handle((document) => {
        attempts.push(document);
        return Promise.reject(new Error('switch refused'));
      }),
      /switch refused/u,
    );
    intake.enqueue(['Second.overlooklibrary'], tmpdir());
    await intake.handle((document) => {
      attempts.push(document);
      return Promise.resolve();
    });
    assert.deepEqual(attempts, [path.join(tmpdir(), 'First.overlooklibrary'), path.join(tmpdir(), 'Second.overlooklibrary')]);
  });

  test('close discards queued documents and removes the handler', async () => {
    const intake = new LibraryDocumentIntake();
    const documents: string[] = [];
    await intake.handle((document) => {
      documents.push(document);
      return Promise.resolve();
    });
    intake.enqueue(['Discarded.overlooklibrary'], tmpdir());
    intake.close();
    assert.equal(intake.hasPending(), false);
    await intake.flush();
    assert.deepEqual(documents, []);
  });
});
