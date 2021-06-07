// Copyright (c) 2020 Gitpod GmbH. All rights reserved.
// Licensed under the GNU Affero General Public License (AGPL).
// See License-AGPL.txt in the project root for license information.

package pprof

import (
	"net/http"
	"net/http/pprof"

	"github.com/gitpod-io/gitpod/common-go/log"
)

// http handler path which MUST be used as a prefix to route pprof endpoint
// since it is hardcoded inside pprof
const Path = "/debug/pprof/"

// Serve starts a new HTTP server serving pprof endpoints on the given addr
func Serve(addr string) {
	mux := Handler()

	log.WithField("addr", addr).Info("serving pprof service")
	err := http.ListenAndServe(addr, mux)
	if err != nil {
		log.WithField("addr", addr).WithError(err).Warn("cannot serve pprof service")
	}
}

// Handler produces the pprof endpoint handler
func Handler() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc(Path, pprof.Index)
	mux.HandleFunc(Path+"cmdline", pprof.Cmdline)
	mux.HandleFunc(Path+"profile", pprof.Profile)
	mux.HandleFunc(Path+"symbol", pprof.Symbol)
	mux.HandleFunc(Path+"trace", pprof.Trace)

	mux.HandleFunc("/debug/logging", log.LevelHandler)

	return mux
}
