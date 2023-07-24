/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as sinon from 'sinon'
import { Ec2ConnectErrorCode, Ec2ConnectionManager } from '../../ec2/model'
import { SsmClient } from '../../shared/clients/ssmClient'
import { Ec2Client } from '../../shared/clients/ec2Client'
import { attachedPoliciesListType } from 'aws-sdk/clients/iam'
import { Ec2Selection } from '../../ec2/utils'
import { ToolkitError } from '../../shared/errors'
import { AWSError, EC2, SSM } from 'aws-sdk'
import { PromiseResult } from 'aws-sdk/lib/request'
import { GetCommandInvocationResult } from 'aws-sdk/clients/ssm'
import { mock } from 'ts-mockito'
import { SshKeyPair } from '../../ec2/sshKeyPair'

describe('Ec2ConnectClient', function () {
    let currentInstanceOs: string
    class MockSsmClient extends SsmClient {
        public constructor() {
            super('test-region')
        }

        public override async getInstanceAgentPingStatus(target: string): Promise<string> {
            return target.split(':')[2]
        }

        public override async getTargetPlatformName(target: string): Promise<string> {
            return currentInstanceOs
        }
    }

    class MockEc2Client extends Ec2Client {
        public constructor() {
            super('test-region')
        }

        public override async getInstanceStatus(instanceId: string): Promise<EC2.InstanceStateName> {
            return instanceId.split(':')[0] as EC2.InstanceStateName
        }
    }

    class MockEc2ConnectClient extends Ec2ConnectionManager {
        public constructor() {
            super('test-region')
        }

        protected override createSsmSdkClient(): SsmClient {
            return new MockSsmClient()
        }

        protected override createEc2SdkClient(): Ec2Client {
            return new MockEc2Client()
        }

        public async testGetRemoteUser(instanceId: string, osName: string) {
            currentInstanceOs = osName
            const remoteUser = await this.getRemoteUser(instanceId)
            return remoteUser
        }
    }

    describe('isInstanceRunning', async function () {
        let client: MockEc2ConnectClient

        before(function () {
            client = new MockEc2ConnectClient()
        })

        it('only returns true with the instance is running', async function () {
            const actualFirstResult = await client.isInstanceRunning('running:noPolicies')
            const actualSecondResult = await client.isInstanceRunning('stopped:noPolicies')

            assert.strictEqual(true, actualFirstResult)
            assert.strictEqual(false, actualSecondResult)
        })
    })

    describe('handleStartSessionError', async function () {
        let client: MockEc2ConnectClientForError

        class MockEc2ConnectClientForError extends MockEc2ConnectClient {
            public override async hasProperPolicies(instanceId: string): Promise<boolean> {
                return instanceId.split(':')[1] === 'hasPolicies'
            }
        }
        before(function () {
            client = new MockEc2ConnectClientForError()
        })

        it('determines which error to throw based on if instance is running', async function () {
            async function assertThrowsErrorCode(testInstance: Ec2Selection, errCode: Ec2ConnectErrorCode) {
                try {
                    await client.checkForStartSessionError(testInstance)
                } catch (err: unknown) {
                    assert.strictEqual((err as ToolkitError).code, errCode)
                }
            }

            await assertThrowsErrorCode(
                {
                    instanceId: 'pending:noPolicies:Online',
                    region: 'test-region',
                },
                'EC2SSMStatus'
            )

            await assertThrowsErrorCode(
                {
                    instanceId: 'shutting-down:noPolicies:Online',
                    region: 'test-region',
                },
                'EC2SSMStatus'
            )

            await assertThrowsErrorCode(
                {
                    instanceId: 'running:noPolicies:Online',
                    region: 'test-region',
                },
                'EC2SSMPermission'
            )

            await assertThrowsErrorCode(
                {
                    instanceId: 'running:hasPolicies:Offline',
                    region: 'test-region',
                },
                'EC2SSMAgentStatus'
            )
        })

        it('does not throw an error if all checks pass', async function () {
            const passingInstance = {
                instanceId: 'running:hasPolicies:Online',
                region: 'test-region',
            }
            assert.doesNotThrow(async () => await client.checkForStartSessionError(passingInstance))
        })
    })

    describe('hasProperPolicies', async function () {
        let client: MockEc2ConnectClientForPolicies
        class MockEc2ConnectClientForPolicies extends MockEc2ConnectClient {
            protected override async getAttachedPolicies(instanceId: string): Promise<attachedPoliciesListType> {
                switch (instanceId) {
                    case 'firstInstance':
                        return [
                            {
                                PolicyName: 'name',
                            },
                            {
                                PolicyName: 'name2',
                            },
                            {
                                PolicyName: 'name3',
                            },
                        ]
                    case 'secondInstance':
                        return [
                            {
                                PolicyName: 'AmazonSSMManagedInstanceCore',
                            },
                            {
                                PolicyName: 'AmazonSSMManagedEC2InstanceDefaultPolicy',
                            },
                        ]
                    case 'thirdInstance':
                        return [
                            {
                                PolicyName: 'AmazonSSMManagedInstanceCore',
                            },
                        ]
                    case 'fourthInstance':
                        return [
                            {
                                PolicyName: 'AmazonSSMManagedEC2InstanceDefaultPolicy',
                            },
                        ]
                    default:
                        return []
                }
            }
        }
        before(function () {
            client = new MockEc2ConnectClientForPolicies()
        })

        it('correctly determines if proper policies are included', async function () {
            let result: boolean

            result = await client.hasProperPolicies('firstInstance')
            assert.strictEqual(false, result)

            result = await client.hasProperPolicies('secondInstance')
            assert.strictEqual(true, result)

            result = await client.hasProperPolicies('thirdInstance')
            assert.strictEqual(false, result)

            result = await client.hasProperPolicies('fourthInstance')
            assert.strictEqual(false, result)
        })
    })

    describe('sendSshKeysToInstance', async function () {
        let client: MockEc2ConnectClient
        let sendCommandStub: sinon.SinonStub<
            [target: string, documentName: string, parameters: SSM.Parameters],
            Promise<PromiseResult<GetCommandInvocationResult, AWSError>>
        >

        before(function () {
            client = new MockEc2ConnectClient()
            sendCommandStub = sinon.stub(MockSsmClient.prototype, 'sendCommandAndWait')
        })

        after(function () {
            sinon.restore()
        })

        it('calls the sdk with the proper parameters', async function () {
            const testSelection = {
                instanceId: 'test-id',
                region: 'test-region',
            }
            const mockKeys = mock() as SshKeyPair
            await client.sendSshKeyToInstance(testSelection, mockKeys, '')
            sinon.assert.calledWith(sendCommandStub, testSelection.instanceId, 'AWS-RunShellScript')
        })
    })

    describe('determineRemoteUser', async function () {
        let client: MockEc2ConnectClient

        before(function () {
            client = new MockEc2ConnectClient()
        })

        it('identifies the user for ubuntu as ubuntu', async function () {
            const remoteUser = await client.testGetRemoteUser('testInstance', 'Ubuntu')
            assert.strictEqual(remoteUser, 'ubuntu')
        })

        it('identifies the user for amazon linux as ec2-user', async function () {
            const remoteUser = await client.testGetRemoteUser('testInstance', 'Amazon Linux')
            assert.strictEqual(remoteUser, 'ec2-user')
        })

        it('throws error when not given known OS', async function () {
            try {
                await client.testGetRemoteUser('testInstance', 'ThisIsNotARealOs!')
                assert.ok(false)
            } catch (exception) {
                assert.ok(true)
            }
        })
    })
})
