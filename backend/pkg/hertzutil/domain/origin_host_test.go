/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package domain

import (
	"testing"

	"github.com/cloudwego/hertz/pkg/app"
	"github.com/stretchr/testify/assert"
)

func TestGetOriginHostStripsPort(t *testing.T) {
	ctx := app.NewContext(0)
	ctx.Request.Header.Set(HeaderKeyOfHost, "9.134.217.222:8888")
	assert.Equal(t, "9.134.217.222", GetOriginHost(ctx))
}

func TestCookieDomainEmptyForIP(t *testing.T) {
	ctx := app.NewContext(0)
	ctx.Request.Header.Set(HeaderKeyOfOrigin, "http://9.134.217.222:8888")
	assert.Equal(t, "", CookieDomain(ctx))
}

func TestCookieDomainKeepsHostname(t *testing.T) {
	ctx := app.NewContext(0)
	ctx.Request.Header.Set(HeaderKeyOfOrigin, "http://studio.example.com:8888")
	assert.Equal(t, "studio.example.com", CookieDomain(ctx))
}
