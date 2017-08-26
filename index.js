// dcc client

var net = require('net');

exports.hook_data_post = function (next, connection) {
    var plugin = this;
    var txn = connection.transaction;

    // Fix-up rDNS for DCC
    var host;
    switch (connection.remote.host) {
        case 'Unknown':
        case 'NXDOMAIN':
        case 'DNSERROR':
        case undefined:
            break;
        default:
            host = connection.remote.host;
            break;
    }

    var rcpts = txn.rcpt_to.map(function (rcpt) { return rcpt.address(); });
    var training = (txn.notes.training_mode && txn.notes.training_mode === 'spam')
        ? true : false;
    var response = '';
    var client = net.createConnection({
        path: '/var/dcc/dccifd'
    }, function () {
        // http://www.dcc-servers.net/dcc/dcc-tree/dccifd.html
        connection.logdebug(plugin, 'connected to dcc');
        var protocol_headers = [
            'header' + ((training) ? ' spam' : ''),
            connection.remote.ip + ((host) ? '\r' + host : ''),
            connection.hello.host,
            txn.mail_from.address(),
            rcpts.join('\r'),
        ].join('\n');
        connection.logdebug(plugin, 'sending protocol headers: ' + protocol_headers);
        this.write(protocol_headers + '\n\n', function () {
            txn.message_stream.pipe(client);
        });
    });

    client.on('error', function (err) {
        connection.logerror(plugin, err.message);
        return next();
    });

    client.on('data', function (chunk) {
        response += chunk.toString('utf8');
    });

    client.on('end', function () {
        var rl = response.split("\n");
        if (rl.length < 2) {
            connection.logwarn(plugin, 'invalid response: ' + response + 'length=' + rl.length);
            return next();
        }
        connection.logdebug(plugin, 'got response: ' + response);
        // Get result code
        var result = rl.shift();
        switch (result) {
            case 'A':
                // Accept, fall through
            case 'G':
                // Greylist, fall through
            case 'R':
                // Reject, fall through
            case 'S':
                // Accept for some recipients, fall through
            case 'T':
                // Temporary failure
                break;
            default:
                connection.logerror(plugin, 'invalid result: ' + result);
                break;
        }
        // Disposition
        var disposition = rl.shift();
        switch (disposition) {
            case 'A':    // Deliver the message
            case 'G':    // Discard the message during greylist embargo
            case 'R':    // Discard the message as spam
                break;
            default:
                connection.logerror(plugin, 'invalid disposition: ' + disposition);
                break;
        }
        // Read headers
        var headers = [];
        for (var i=0; i<rl.length; i++) {
            if (/^\s/.test(rl[i]) && headers.length) {
                // Continuation
                headers[headers.length-1] += rl[i];
            }
            else {
                if (rl[i]) headers.push(rl[i]);
            }
        }
        connection.logdebug(this, 'found ' + headers.length + ' headers');
        for (var h=0; h<headers.length; h++) {
            var header = headers[h].toString('utf8').trim();
            var match;
            if ((match = /^([^: ]+):\s*((?:.|[\r\n])+)/.exec(header))) {
                txn.add_header(match[1], match[2]);
            }
            else {
                connection.logerror(this, 'header did not match regexp: ' + header);
            }
        }
        connection.loginfo(plugin, 'training=' + (training ? 'Y' : 'N') + ' result=' + result +
                                 ' disposition=' + disposition + ' headers=' + headers.length);
        return next();
    });
}

