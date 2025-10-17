/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { z } from '../../sdk/bundle';
import { defineTabTool } from './tool';

import type * as playwright from 'playwright-core';
import type { NetworkRequestData } from '../tab';

const requests = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_network_requests',
    title: 'List network requests',
    description: 'Returns all network requests since loading the page with full request/response details',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    const requestsData = await tab.requests();
    for (const requestData of requestsData) {
      const rendered = await renderRequest(requestData);
      response.addResult(JSON.stringify(rendered, null, 2));
    }
  },
});

// Helper to add timeout to promises
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))
  ]);
}

// Resource types that warrant body capture (API calls and documents)
const CAPTURE_BODY_RESOURCE_TYPES = ['xhr', 'fetch', 'document'];

async function renderRequest(data: NetworkRequestData) {
  const request = data.request;
  const resourceType = request.resourceType();

  // Basic request info
  const result: any = {
    url: request.url(),
    method: request.method(),
    resourceType: resourceType,
    status: data.status,
  };

  // Request details
  try {
    result.request = {
      headers: await withTimeout(
        request.allHeaders().catch(() => request.headers()),
        1000,
        request.headers()
      ),
      postData: request.postData(),
      postDataJSON: request.postDataJSON(),
    };
  } catch (e) {
    result.request = { error: 'Failed to capture request details' };
  }

  // Timing information
  try {
    result.timing = request.timing();
  } catch (e) {
    // Timing might not be available yet
  }

  // Size information
  try {
    result.sizes = await withTimeout(request.sizes(), 1000, undefined);
  } catch (e) {
    // Size info might not be available
  }

  // Response details (if available)
  if (data.response) {
    try {
      const response = data.response;
      result.response = {
        status: response.status(),
        statusText: response.statusText(),
        ok: response.ok(),
        headers: await withTimeout(
          response.allHeaders().catch(() => response.headers()),
          1000,
          response.headers()
        ),
        url: response.url(),
      };

      // Only capture body for API calls and documents, not static assets
      const shouldCaptureBody = CAPTURE_BODY_RESOURCE_TYPES.includes(resourceType);

      if (shouldCaptureBody) {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            result.response.body = await withTimeout(
              response.json().catch(async () => {
                // Fallback to text if JSON parsing fails
                return await response.text().catch(() => '<body unavailable>');
              }),
              2000,
              '<body capture timeout>'
            );
          } else if (contentType.includes('text/') || contentType.includes('application/javascript')) {
            const text = await withTimeout(
              response.text().catch(() => '<body unavailable>'),
              2000,
              '<body capture timeout>'
            );
            // Limit to 5000 characters to avoid huge logs
            result.response.body = typeof text === 'string' && text.length > 5000
              ? text.substring(0, 5000) + '... (truncated)'
              : text;
          } else {
            result.response.body = '<non-text content>';
          }
        } catch (e) {
          result.response.body = '<failed to capture body>';
        }
      } else {
        // Skip body capture for static assets (images, fonts, stylesheets, etc.)
        result.response.body = '<body not captured for static asset>';
      }

      // Security details (optional, with timeout)
      try {
        result.response.securityDetails = await withTimeout(
          response.securityDetails(),
          500,
          undefined
        );
      } catch (e) {
        // Security details might not be available
      }

      // Server address (optional, with timeout)
      try {
        result.response.serverAddr = await withTimeout(
          response.serverAddr(),
          500,
          undefined
        );
      } catch (e) {
        // Server address might not be available
      }
    } catch (e) {
      result.response = { error: 'Failed to capture response details' };
    }
  }

  // Error details (if failed)
  if (data.status === 'failed' && data.error) {
    result.error = data.error;
  }

  return result;
}

export default [
  requests,
];
