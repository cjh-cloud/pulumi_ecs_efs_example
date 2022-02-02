import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const SERVICE_NAME = 'mongo';
const MONGO_PORT = 27017;
const NFS_PORT = 2049;

const vpc = new awsx.ec2.Vpc(`${SERVICE_NAME}-vpc`, {
    cidrBlock: "10.0.0.0/16"
});

// Export a few resulting fields to make them easy to use:
export const vpcId = vpc.id;
export const vpcPrivateSubnetIds = vpc.privateSubnetIds;
export const vpcPublicSubnetIds = vpc.publicSubnetIds;

export const publicSubnet_1 = pulumi.output(vpc.publicSubnetIds)[0];
export const publicSubnet_2 = pulumi.output(vpc.publicSubnetIds)[1];

// Allocate a security group and then a series of rules:
const sg = new awsx.ec2.SecurityGroup(`${SERVICE_NAME}-sg`, { vpc });

// inbound nfs traffic on port 2049 from a specific IP address
sg.createIngressRule("nfs-access", {
    location: new awsx.ec2.AnyIPv4Location(),
    ports: new awsx.ec2.TcpPorts(NFS_PORT),
    description: "allow NFS access for EFS from anywhere",
});

// inbound Mongo traffic on port 27017 from anywhere
sg.createIngressRule("mongo-access", {
    location: new awsx.ec2.AnyIPv4Location(),
    ports: new awsx.ec2.TcpPorts(MONGO_PORT),
    description: "allow Mongo access from anywhere",
});

// outbound TCP traffic on any port to anywhere
sg.createEgressRule("outbound-access", {
    location: new awsx.ec2.AnyIPv4Location(),
    ports: new awsx.ec2.AllTcpPorts(),
    description: "allow outbound access to anywhere",
});

const efs = new aws.efs.FileSystem(`${SERVICE_NAME}-efs`, {
    tags: {
        Name: `${SERVICE_NAME}-data`,
    },
});

// Create a mount target for both public subnets
const publicMountTarget_1 = new aws.efs.MountTarget(`${SERVICE_NAME}-publicMountTarget-1`, {
    fileSystemId: efs.id,
    subnetId: publicSubnet_1,
    securityGroups: [sg.id]
});

const publicMountTarget_2 = new aws.efs.MountTarget(`${SERVICE_NAME}-publicMountTarget-2`, {
    fileSystemId: efs.id,
    subnetId: publicSubnet_2,
    securityGroups: [sg.id]
});

// Creates a Network Load Balancer associated with our custom VPC.
const nlb = new awsx.lb.NetworkLoadBalancer(`${SERVICE_NAME}-service`, { vpc });

// Listen to Mongo traffic on port 27017
const mongoListener = nlb.createListener(`${SERVICE_NAME}-lb-listener`, { 
    port: MONGO_PORT,
    protocol: "TCP",
});

// Export the load balancer's address so that it's easy to access.
export const url = nlb.loadBalancer.dnsName;

// Fargate Cluster
const cluster = new awsx.ecs.Cluster(`${SERVICE_NAME}-cluster`, { vpc });

const mongoService = new awsx.ecs.FargateService(SERVICE_NAME, {
    cluster,
    desiredCount: 2,
    securityGroups: [sg.id],
    taskDefinitionArgs: {
        containers: {
            mongo: {
                image: "mongo",
                memory: 128,
                portMappings: [ mongoListener ],
                mountPoints: [
                    {
                        containerPath: "/data/db",
                        sourceVolume: `${SERVICE_NAME}-volume`
                    }
                ]
            },
        },
        volumes: [
            {
                name: `${SERVICE_NAME}-volume`,
                efsVolumeConfiguration: {
                    fileSystemId: publicMountTarget_1.fileSystemId,
                    transitEncryption: "ENABLED"
                }
            }
        ]
    },
});
